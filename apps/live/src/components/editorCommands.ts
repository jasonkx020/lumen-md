import type { Crepe } from "@milkdown/crepe";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  insertTableCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { callCommand, replaceAll } from "@milkdown/kit/utils";
import type { MenuAction } from "./MenuBar";
import { DEFAULT_MERMAID_TEMPLATE } from "../diagrams/mermaidIcon";

export function runFormatAction(crepe: Crepe | null, action: MenuAction): boolean {
  if (!crepe) return false;
  const run = (cmd: unknown, payload?: unknown) => {
    crepe.editor.action(callCommand(cmd as never, payload as never));
  };

  switch (action) {
    case "bold":
      run(toggleStrongCommand.key);
      return true;
    case "italic":
      run(toggleEmphasisCommand.key);
      return true;
    case "inlineCode":
      run(toggleInlineCodeCommand.key);
      return true;
    case "strikethrough":
      run(toggleStrikethroughCommand.key);
      return true;
    case "heading1":
      run(wrapInHeadingCommand.key, 1);
      return true;
    case "heading2":
      run(wrapInHeadingCommand.key, 2);
      return true;
    case "heading3":
      run(wrapInHeadingCommand.key, 3);
      return true;
    case "paragraph":
      run(turnIntoTextCommand.key);
      return true;
    case "blockquote":
      run(wrapInBlockquoteCommand.key);
      return true;
    case "bulletList":
      run(wrapInBulletListCommand.key);
      return true;
    case "orderedList":
      run(wrapInOrderedListCommand.key);
      return true;
    case "codeBlock":
      run(createCodeBlockCommand.key);
      return true;
    case "mermaid": {
      const md = crepe.getMarkdown();
      const block = `\n\n\`\`\`mermaid\n${DEFAULT_MERMAID_TEMPLATE}\n\`\`\`\n`;
      crepe.editor.action(replaceAll(`${md.trimEnd()}${block}`, true));
      return true;
    }
    case "table":
      run(insertTableCommand.key, { row: 3, col: 3 });
      return true;
    case "hr":
      run(insertHrCommand.key);
      return true;
    case "link": {
      const href = window.prompt("链接地址", "https://");
      if (!href) return true;
      const label = window.prompt("链接文字", href) ?? href;
      const md = crepe.getMarkdown();
      const next = `${md.trimEnd()}\n\n[${label}](${href})\n`;
      crepe.editor.action(replaceAll(next, true));
      return true;
    }
    case "undo":
    case "redo":
    case "cut":
    case "copy":
    case "paste":
    case "selectAll":
      document.execCommand(
        action === "undo"
          ? "undo"
          : action === "redo"
            ? "redo"
            : action === "cut"
              ? "cut"
              : action === "copy"
                ? "copy"
                : action === "paste"
                  ? "paste"
                  : "selectAll",
      );
      return true;
    default:
      return false;
  }
}
