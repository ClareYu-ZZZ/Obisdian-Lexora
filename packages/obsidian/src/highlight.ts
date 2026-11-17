import { editorInfoField } from 'obsidian';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, ViewUpdate, type DecorationSet,
} from '@codemirror/view';
import { scan } from '@elp/core';
import type ElpPlugin from './main';
import { inScope } from './settings';

/** Dispatched by the plugin whenever the highlight index changes. */
export const elpRefreshEffect = StateEffect.define<number>();

export function buildEditorExtension(plugin: ElpPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(elpRefreshEffect)),
        );
        if (update.docChanged || update.viewportChanged || refreshed) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const info = view.state.field(editorInfoField, false);
        const path = info?.file?.path;
        if (!inScope(plugin.settings, path) || plugin.index.size === 0) {
          return builder.finish();
        }
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          for (const hit of scan(text, plugin.index)) {
            builder.add(
              from + hit.start,
              from + hit.end,
              Decoration.mark({
                class: `elp-word elp-${hit.info.status}`,
                attributes: {
                  'data-elp-lemma': hit.info.lemma,
                  ...(hit.info.color ? { style: `--elp-bc:${hit.info.color}` } : {}),
                },
              }),
            );
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON']);

/** Reading-view highlighter: wraps matches in span.elp-word. */
export function highlightElement(plugin: ElpPlugin, root: HTMLElement, sourcePath: string): void {
  if (!inScope(plugin.settings, sourcePath) || plugin.index.size === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.elp-word')) return NodeFilter.FILTER_REJECT;
      for (let el: HTMLElement | null = parent; el && el !== root; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const hits = scan(text, plugin.index);
    if (hits.length === 0) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const hit of hits) {
      if (hit.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, hit.start)));
      const span = document.createElement('span');
      span.className = `elp-word elp-${hit.info.status}`;
      span.setAttribute('data-elp-lemma', hit.info.lemma);
      if (hit.info.color) span.style.setProperty('--elp-bc', hit.info.color);
      span.textContent = text.slice(hit.start, hit.end);
      frag.appendChild(span);
      pos = hit.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
}
