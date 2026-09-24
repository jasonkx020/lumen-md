import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Crepe } from "@milkdown/crepe";
import { replaceAll } from "@milkdown/kit/utils";
import { normalizeGfmTables } from "../markdown/normalizeGfmTables";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "@milkdown/prose/tables/style/tables.css";

export type CrepeEditorHandle = {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  runAction: (fn: (ctx: unknown) => void) => void;
  getCrepe: () => Crepe | null;
};

type Props = {
  initialMarkdown?: string;
  onChange?: (md: string) => void;
  className?: string;
};

function applyMarkdown(crepe: Crepe, md: string) {
  crepe.editor.action(replaceAll(normalizeGfmTables(md), true));
}

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor({ initialMarkdown = "", onChange, className }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyRef = useRef(false);
    const lastMdRef = useRef(normalizeGfmTables(initialMarkdown));
    const onChangeRef = useRef(onChange);
    const suppressRef = useRef(0);
    onChangeRef.current = onChange;

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        const c = crepeRef.current;
        if (c && readyRef.current) {
          try {
            lastMdRef.current = c.getMarkdown();
          } catch {
            /* keep last */
          }
        }
        return lastMdRef.current;
      },
      setMarkdown: (md: string) => {
        const normalized = normalizeGfmTables(md);
        lastMdRef.current = normalized;
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        suppressRef.current += 1;
        try {
          applyMarkdown(c, normalized);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
          }, 0);
        }
      },
      focus: () => {
        rootRef.current
          ?.querySelector<HTMLElement>(".ProseMirror")
          ?.focus();
      },
      runAction: (fn) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        c.editor.action(fn as never);
      },
      getCrepe: () => crepeRef.current,
    }));

    useEffect(() => {
      const el = rootRef.current;
      if (!el) return;
      let disposed = false;
      const crepe = new Crepe({
        root: el,
        defaultValue: lastMdRef.current || initialMarkdown,
        features: {
          [Crepe.Feature.Table]: true,
        },
        featureConfigs: {
          // 关闭虚拟光标：表格单元格内原生 caret 才能稳定可见
          [Crepe.Feature.Cursor]: {
            virtual: false,
          },
          [Crepe.Feature.Placeholder]: {
            text: "开始写作…",
            mode: "block",
          },
          [Crepe.Feature.BlockEdit]: {
            textGroup: {
              label: "文本",
              text: { label: "正文" },
              h1: { label: "一级标题" },
              h2: { label: "二级标题" },
              h3: { label: "三级标题" },
              h4: { label: "四级标题" },
              h5: { label: "五级标题" },
              h6: { label: "六级标题" },
              quote: { label: "引用" },
              divider: { label: "分隔线" },
            },
            listGroup: {
              label: "列表",
              bulletList: { label: "无序列表" },
              orderedList: { label: "有序列表" },
              taskList: { label: "任务列表" },
            },
            advancedGroup: {
              label: "高级",
              image: { label: "图片" },
              codeBlock: { label: "代码块" },
              table: { label: "表格" },
              math: { label: "公式" },
            },
          },
        },
      });
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          if (suppressRef.current > 0) return;
          lastMdRef.current = markdown;
          onChangeRef.current?.(markdown);
        });
      });
      crepeRef.current = crepe;
      void crepe.create().then(() => {
        if (disposed) return;
        readyRef.current = true;
        // 打开文件可能发生在 create 完成前：就绪后再灌入最新内容
        suppressRef.current += 1;
        try {
          applyMarkdown(crepe, lastMdRef.current);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
          }, 0);
        }
      });
      return () => {
        disposed = true;
        readyRef.current = false;
        void crepe.destroy();
        crepeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div ref={rootRef} className={className ?? "crepe-host"} />;
  },
);
