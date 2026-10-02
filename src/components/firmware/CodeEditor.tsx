import { cpp } from "@codemirror/lang-cpp";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

/** The language of a keymap folder's file: C for .c/.h, JSON, make for rules.mk. */
function language(path: string): Extension[] {
  const name = path.toLowerCase();
  if (/\.(c|h|cpp|hpp|inc)$/.test(name)) return [cpp()];
  if (name.endsWith(".json")) return [json()];
  if (name.endsWith(".mk") || name.endsWith("makefile")) return [StreamLanguage.define(shell)];
  return [];
}

/** The app's colours (CSS variables, so it follows the light or dark theme). */
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--desk)", color: "var(--text)", fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--live)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--live)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
    ".cm-gutters": { backgroundColor: "var(--desk)", color: "var(--status-off)", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
    ".cm-activeLine": { backgroundColor: "var(--active-line)" },
    ".cm-matchingBracket": { backgroundColor: "rgb(92 200 182 / 0.25) !important", outline: "none" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--panel-2)", border: "none", color: "var(--muted)" },
    ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
    ".cm-panels input, .cm-panels button": { color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "rgb(242 193 78 / 0.25)" },
    ".cm-searchMatch-selected": { backgroundColor: "rgb(242 193 78 / 0.5)" },
    ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", color: "var(--text)" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--panel-2)", color: "var(--text)" },
    ".cm-line.is-revealed": { backgroundColor: "rgb(228 112 92 / 0.18)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--syn-meta)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.definition(t.variableName), t.propertyName], color: "var(--syn-name)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** Each file's editor state (text, undo history, cursor), kept while its tab is open. */
const states = new Map<string, EditorState>();
export function forgetEditorState(key: string) {
  states.delete(key);
}

export function CodeEditor(props: {
  fileKey: string;
  path: string;
  text: string;
  onChange(text: string): void;
  onSave(): void;
  /** A line to show (from a problem); `n` changes on each request. */
  reveal?: { line: number; n: number } | null;
}) {
  const { fileKey, path, text, onChange, onSave, reveal } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handlers.current.onSave();
              return true;
            },
          },
        ]),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        theme,
        syntaxHighlighting(highlight),
        ...language(path),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
        }),
      ],
    });

  // One view; switching files swaps its state (each file keeps its own undo history).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a file switch only; `text` is read once to seed a new file's state
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current, state: states.get(fileKey) ?? makeState(text) });
    view.current = v;
    return () => {
      states.set(fileKey, v.state);
      v.destroy();
      view.current = null;
    };
  }, [fileKey]);

  // The text changed outside the editor (undo of a file operation, the module added): take it.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== text) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    }
  }, [text]);

  // On `reveal.n` alone: it counts requests, so clicking the same problem twice reveals it
  // again. Depending on `reveal` itself would re-run on every render that rebuilds the object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on `reveal.n` alone, see above
  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const line = v.state.doc.line(Math.min(Math.max(reveal.line, 1), v.state.doc.lines));
    v.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [reveal?.n]);

  return <div className="code-editor" ref={host} />;
}
