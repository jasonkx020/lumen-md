/**
 * Mermaid 规范化自检（无需浏览器 DOM）。
 */
import {
  looksLikeMermaidDiagram,
  normalizeMermaidFencesInMarkdown,
  prepareMermaidSource,
  unescapeMermaidBrackets,
} from "./normalizeMermaidMd";

const USER_ESCAPED = `flowchart TB
  subgraph entry \\[入口]
  CLI\\[memo-cli memo.exe]
  GUI\\[memo-app egui]
  end
  subgraph core \\[memo-core]
  ID\\[identity_keys]
  SVC\\[MemoService]
  MS\\[MemoStore LWW]
  PS\\[PersonStore]
  TS\\[TaskStore]
  HS\\[HostedStore]
  AU\\[AuditLog]
  end
  subgraph sync \\[memo-sync]
  UDP\\[UDP Announce :17000]
  TCP\\[TCP Sync]
  ENG\\[SyncEngine]
  end
  CLI --> GUI
  CLI --> SVC
  GUI --> SVC
  GUI --> ENG
  CLI --> ENG
  ID --> SVC
  SVC --> MS
  SVC --> PS
  SVC --> TS
  SVC --> HS
  SVC --> AU
  ENG --> MS
  ENG --> PS
  ENG --> TS
  UDP --> ENG
  TCP --> ENG`;

export function runMermaidNormalizeSelfCheck(): string[] {
  const errors: string[] = [];

  if (unescapeMermaidBrackets("CLI\\[memo]") !== "CLI[memo]") {
    errors.push("unescapeMermaidBrackets failed");
  }
  if (!looksLikeMermaidDiagram("flowchart TB\nA-->B")) {
    errors.push("looksLikeMermaidDiagram should match flowchart");
  }
  if (looksLikeMermaidDiagram("const x = 1")) {
    errors.push("looksLikeMermaidDiagram false positive");
  }

  const prepared = prepareMermaidSource(USER_ESCAPED);
  if (prepared.includes("\\[")) {
    errors.push("prepareMermaidSource left backslash-brackets");
  }
  if (!prepared.includes("CLI[memo-cli memo.exe]")) {
    errors.push("prepareMermaidSource missing unescaped node");
  }
  if (!prepared.includes("subgraph entry [入口]")) {
    errors.push("prepareMermaidSource missing unescaped subgraph");
  }

  const fenced = "```\n" + USER_ESCAPED + "\n```\n";
  const norm = normalizeMermaidFencesInMarkdown(fenced);
  if (!norm.startsWith("```mermaid\n")) {
    errors.push("normalizeMermaidFencesInMarkdown should tag mermaid lang");
  }
  if (norm.includes("\\[")) {
    errors.push("normalizeMermaidFencesInMarkdown left escapes");
  }

  const already = "```mermaid\nflowchart LR\nA\\[x]\n```\n";
  const norm2 = normalizeMermaidFencesInMarkdown(already);
  if (!norm2.includes("A[x]")) {
    errors.push("mermaid-lang fence unescape failed");
  }

  return errors;
}
