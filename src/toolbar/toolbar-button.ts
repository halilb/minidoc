import { h } from '../dom';
import { MinidocToolbarAction, MinidocToolbarEditor } from './toolbar-types';

export function ToolbarButton(
  editor: MinidocToolbarEditor,
  { label, isActive, html, run }: Pick<MinidocToolbarAction, 'label' | 'isActive' | 'html' | 'run'>,
) {
  const btn = h('button.minidoc-toolbar-btn', {
    refreshState:
      isActive &&
      ((editor: MinidocToolbarEditor) =>
        btn.classList.toggle('minidoc-toolbar-btn-active', isActive(editor))),
    onclick() {
      run(editor);
    },
    type: 'button',
    'aria-label': label,
    innerHTML: html,
  });
  return btn;
}
