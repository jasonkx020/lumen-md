/** 将 HTML table atom 提升为可编辑 ProseMirror table，并提供保留合并单元格的 Markdown 序列化。 */

import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import {
  htmlToPmTable,
  isTableHtml,
  replaceMergedTablesWithHtml,
} from "./htmlTable";

const key = new PluginKey("html-table-promote");

function promoteHtmlTables() {
  return new Plugin({
    key,
    view(view) {
      queueMicrotask(() => {
        if (!(view as { isDestroyed?: boolean }).isDestroyed) {
          view.dispatch(view.state.tr.setMeta("html-table-force", true));
        }
      });
      return {};
    },
    appendTransaction(transactions, _oldState, newState) {
      if (transactions.some((tr) => tr.getMeta("html-table-promote"))) {
        return null;
      }
      const shouldScan =
        transactions.some((tr) => tr.docChanged) ||
        transactions.some((tr) => tr.getMeta("html-table-force"));
      if (!shouldScan) return null;

      const schema = newState.schema;
      if (!schema.nodes.html || !schema.nodes.table) return null;

      type Rep = {
        from: number;
        to: number;
        table: NonNullable<ReturnType<typeof htmlToPmTable>>;
      };
      const reps: Rep[] = [];

      newState.doc.descendants((node, pos) => {
        if (
          node.type.name === "paragraph" &&
          node.childCount === 1 &&
          node.firstChild?.type.name === "html"
        ) {
          const value = String(node.firstChild.attrs.value ?? "");
          if (!isTableHtml(value)) return;
          const table = htmlToPmTable(schema, value);
          if (table) reps.push({ from: pos, to: pos + node.nodeSize, table });
          return;
        }
        if (node.type.name === "html") {
          const value = String(node.attrs.value ?? "");
          if (!isTableHtml(value)) return;
          const $pos = newState.doc.resolve(pos);
          // 若父级 paragraph 会在上面处理，跳过，避免重复
          if ($pos.parent.type.name === "paragraph" && $pos.parent.childCount === 1) {
            return;
          }
          const table = htmlToPmTable(schema, value);
          if (table) reps.push({ from: pos, to: pos + node.nodeSize, table });
        }
      });

      if (reps.length === 0) return null;

      let tr = newState.tr;
      for (const r of reps.reverse()) {
        tr = tr.replaceWith(r.from, r.to, r.table);
      }
      tr.setMeta("addToHistory", false);
      tr.setMeta("html-table-promote", true);
      return tr;
    },
  });
}

/** Milkdown 插件：文档中的 HTML table 预览块 → 可编辑 table。 */
export const htmlTablePromotePlugin = $prose(() => promoteHtmlTables());

/**
 * 序列化 Markdown：带 rowspan/colspan 的表写回 HTML，其余走默认 serializer。
 */
export function serializeMarkdownPreservingHtmlTables(ctx: Ctx): string {
  const view = ctx.get(editorViewCtx);
  const serializer = ctx.get(serializerCtx);
  const mapped = replaceMergedTablesWithHtml(view.state.doc, view.state.schema);
  return serializer(mapped);
}
