import { h, isBlock, isCard, isElement, isList } from '../dom';
import { EditorMiddlewareMixin, MinidocBase } from '../types';

export interface Scrubbable {
  scrub(content: DocumentFragment): DocumentFragment;
}

type AttrRules = Record<string, boolean | ((val?: string) => boolean)>;
interface ScrubbableRules {
  leaf: Record<string, AttrRules>;
  child: Record<string, AttrRules>;
}
type Scrubber = (node: DocumentFragment, editor: MinidocBase) => DocumentFragment;

const isSafeUrl = (s?: string) => !s?.startsWith('javascript:');

export const rules: ScrubbableRules = {
  leaf: {
    P: {},
    BLOCKQUOTE: {},
    H1: {},
    H2: {},
    H3: {},
    H4: {},
    UL: {},
    OL: {},
  },
  child: {
    A: { href: isSafeUrl },
    I: {},
    B: {},
    BR: {},
    STRONG: {},
    EM: {},
    MARK: { 'data-bg': true },
    LI: {},
  },
};

function scrubContext() {
  const frag = document.createDocumentFragment();
  let stack: Element[] = [];
  let leaf: Element | undefined;

  const me = {
    frag,
    get leaf() {
      return leaf;
    },
    set leaf(val: Element | undefined) {
      leaf = val;
      stack = [];
      if (val) {
        stack.push(val);
        frag.append(val);
      }
    },
    get current() {
      return stack[stack.length - 1];
    },
    addLeaf(node: Element) {
      me.leaf = node;
    },
    closeLeaf() {
      me.leaf = undefined;
    },
    addInline(node: Node) {
      if (!me.leaf) {
        me.leaf = h('p');
      }
      me.current.append(node);
      if (isElement(node)) {
        stack.push(node);
      }
    },
    closeInline() {
      stack.pop();
    },
  };

  return me;
}

type Ctx = ReturnType<typeof scrubContext>;

export const createScrubber = (rules: ScrubbableRules): Scrubber => {
  function scrubChildren(childNodes: Node[], ctx: Ctx) {
    childNodes.forEach((child) => {
      scrub(child, ctx);
    });
  }

  function sanitizeAttrs(tagName: string, el: Element) {
    const result = h(tagName);
    const attrRules = rules.leaf[tagName] || rules.child[tagName];
    if (attrRules) {
      el.getAttributeNames().forEach((a) => {
        const isAllowable = attrRules[a];
        const val = el.getAttribute(a) || undefined;
        if (isAllowable === true || (typeof isAllowable === 'function' && isAllowable(val))) {
          result.setAttribute(a, val || '');
        }
      });
    }
    return result;
  }

  function sanitizeLeaf(node: Element) {
    return sanitizeAttrs(rules.leaf[node.tagName] ? node.tagName : 'P', node);
  }

  function sanitizeInline(node: Element) {
    return sanitizeAttrs(node.tagName, node);
  }

  function promoteToLeaf(node: Node, ctx: Ctx) {
    ctx.addLeaf(sanitizeLeaf(node as Element));
    scrubChildren(Array.from(node.childNodes), ctx);
    ctx.closeLeaf();
  }

  function addInline(node: Element, ctx: Ctx) {
    ctx.addInline(sanitizeInline(node));
    scrubChildren(Array.from(node.childNodes), ctx);
    ctx.closeInline();
  }

  function scrub(node: Node, ctx: Ctx) {
    if (isCard(node)) {
      ctx.addLeaf(node);
      ctx.closeLeaf();
      return;
    }

    if (isList(node)) {
      if (!ctx.current?.matches('li')) {
        promoteToLeaf(node, ctx);
      } else {
        addInline(node, ctx);
      }
      return;
    }

    if (!isElement(node)) {
      ctx.addInline(node);
      return;
    }

    if (rules.leaf[node.tagName] || (!rules.child[node.tagName] && isBlock(node))) {
      promoteToLeaf(node, ctx);
      return;
    }

    if (rules.child[node.tagName]) {
      addInline(node, ctx);
      return;
    }

    scrubChildren(Array.from(node.childNodes), ctx);
  }

  return (frag) => {
    const ctx = scrubContext();
    scrubChildren(
      Array.from(frag.childNodes).filter((n) => {
        if (isElement(n)) {
          return !!n.childNodes.length;
        }
        return !!n.textContent?.trim()?.length;
      }),
      ctx,
    );

    return ctx.frag;
  };
};

export const middleware =
  (scrubber: Scrubber = createScrubber(rules)): EditorMiddlewareMixin<Scrubbable> =>
  (next, editor) => {
    const result = editor as MinidocBase & Scrubbable;

    result.scrub = (content) => scrubber(content, result);

    return next(result);
  };
