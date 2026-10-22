import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCardSpec,
  compileSimpleCard,
  escapeText,
  validateCardContent,
} from '../lib/card-syntax.js';
import {
  addAnswerLine,
  addAudio,
  addCardRef,
  addChoice,
  addFormulaBlock,
  addHeading,
  addImage,
  addInlineFormula,
  addList,
  applyCloze,
  buildMask,
  compileDraft,
  createDraft,
  formatSelection,
  parseImageSize,
  plainTextOfDraft,
  snapshot,
  typeText,
  undo,
} from '../lib/card-editor.js';
import { registerTools, TOOL_NAMES } from '../lib/tools.js';

function fakeTools(engine, client) {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
  };
  registerTools(ctx, { engine, client, config: { maxOutputChars: 20000 } });
  return registered;
}

function fakeEngine() {
  const calls = [];
  return {
    calls,
    ready: async () => {},
    touch: () => {},
    createCard: async (payload) => {
      calls.push(payload);
      return { ok: true, card_id: 'local_cd_syntax_test', status: 'new' };
    },
    updateCard: async (payload) => {
      calls.push(payload);
      return { ok: true, card_id: payload.card, changed: true, pending: true };
    },
  };
}

test('compileSimpleCard produces validated plain front/back content and escapes literals', () => {
  const compiled = compileSimpleCard({ title: '标题', front: '问题 [不是标签]？', back: '答案。' });
  assert.match(compiled.content, /^\[P#H1,center#\[T#B#标题\]\]/);
  assert.match(compiled.content, /问题 \\\[不是标签\\\]？/);
  assert.match(compiled.content, /\n---\n/);
  const check = validateCardContent(compiled.content);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('compileCardSpec covers styles, formula cloze, choices, media, card refs and lists', () => {
  const compiled = compileCardSpec({
    pages: [
      [
        { type: 'heading', text: '标题', subtitle: 'Subtitle' },
        { type: 'paragraph', runs: [{ text: '普通' }, { text: '强调', bold: true, color: 'ff2600' }] },
        { type: 'formula', parts: ['k=', { cloze: '\\frac{\\Delta y}{\\Delta x}', group: 1 }] },
        { type: 'choice', options: ['正确', '错误一', '错误二'], correct: [2, 3], fixed: true },
        { type: 'list', items: ['一级', { text: '二级', level: 2 }] },
      ],
      [
        { type: 'image', file: 'mkjf_image', mask: 'mkjf_mask' },
        { type: 'audio', file: 'mkjf_audio', label: '播放', play: 'manual' },
        { type: 'card_ref', ids: ['root_a', 'root_b'], label: '参见' },
      ],
    ],
  });
  assert.match(compiled.content, /\[P#H1,center#\[T#B#标题\]\]/);
  assert.match(compiled.content, /\[T#B,!ff2600#强调\]/);
  assert.match(compiled.content, /\[E##k=\[F#1#\\frac\{\\Delta y\}\{\\Delta x\}\]\]/);
  assert.match(compiled.content, /\[Choice#fixed,multi#/);
  assert.match(compiled.content, /\[P#L,I2#二级\]/);
  assert.match(compiled.content, /\[Pic#ID\/mkjf_image,MID\/mkjf_mask#\]/);
  assert.match(compiled.content, /\[Audio#M,ID\/mkjf_audio#播放\]/);
  assert.match(compiled.content, /\[Card#ID\/root_a-root_b#参见\]/);
  assert.equal(validateCardContent(compiled.content).ok, true);
});

test('validateCardContent distinguishes valid guide examples from common mistakes', () => {
  assert.equal(validateCardContent('正文 \\[字面括号\\]').ok, true);
  assert.equal(validateCardContent('[E##x=\\left[0,1\\right]]').ok, true, 'LaTeX bracket delimiters are not the tag close');
  assert.equal(validateCardContent('[Pic#ID/1kIBX#]\n[Audio#A,ID/1kIBX#播放]').ok, true);
  assert.equal(validateCardContent('[Card#ID/4wJYw#参见]').ok, true);
  assert.equal(validateCardContent('[X##foo]').ok, false);
  assert.equal(validateCardContent('[Choice##\n* A\n* B\n]').ok, false);
  assert.equal(validateCardContent('[F#0#x]').ok, false);
  assert.equal(validateCardContent('[E##$x$]').ok, false);
  const placeholder = validateCardContent('[Pic#ID/<imageFileId>#]');
  assert.equal(placeholder.ok, false);
  assert.ok(placeholder.warnings.some((warning) => warning.code === 'placeholder'));
});

test('escapeText only escapes literal brackets and preserves Markji newlines', () => {
  assert.equal(escapeText('a[b]c\n\\[d\\]'), 'a\\[b\\]c\n\\[d\\]');
});

test('interactive draft compiles after typing, selecting and formatting', () => {
  const draft = createDraft({ id: 'd_test', deck: 'deck1', chapter: 'chap1' });
  snapshot(draft);
  typeText(draft, '光合作用主要发生在哪里？');
  addAnswerLine(draft);
  typeText(draft, '叶绿体。');
  typeText(draft, '它是植物细胞中的结构。');
  assert.match(plainTextOfDraft(draft), /光合作用/);
  const formatted = formatSelection(draft, { target: '叶绿体', style: 'bold' });
  assert.equal(formatted.target, '叶绿体');
  const cloze = applyCloze(draft, { target: '植物细胞', group: 1 });
  assert.equal(cloze.group, 1);
  const compiled = compileDraft(draft);
  assert.match(compiled.content, /\[T#B#叶绿体\]/);
  assert.match(compiled.content, /\[F#1#植物细胞\]/);
  assert.match(compiled.content, /\n---\n/);
  snapshot(draft);
  addHeading(draft, '临时标题');
  assert.match(plainTextOfDraft(draft), /临时标题/);
  undo(draft);
  assert.doesNotMatch(plainTextOfDraft(draft), /临时标题/);
});

test('cloze on styled text fails without mutating the draft', () => {
  const draft = createDraft({ id: 'd_cloze_style', deck: 'd', chapter: 'c' });
  typeText(draft, '强调文字');
  formatSelection(draft, { target: '强调文字', style: 'bold' });
  const before = JSON.stringify(draft.blocks);
  assert.throws(() => applyCloze(draft, { target: '强调文字', group: 1 }), /already has a style/);
  assert.equal(JSON.stringify(draft.blocks), before);
});

test('draft supports choice, list, formula parts, image/audio and card refs', () => {
  const draft = createDraft({ id: 'd_blocks', deck: 'd', chapter: 'c' });
  addChoice(draft, { options: ['A', 'B', 'C'], correct: [2, 3], fixed: true });
  addList(draft, { items: ['一', { text: '二', level: 2 }] });
  addFormulaBlock(draft, ['k=', { cloze: '\\frac{1}{2}', group: 1 }]);
  addInlineFormula(draft, 'x^2');
  addImage(draft, { file: 'mkjf_img', mask: 'mkjf_mask' });
  addAudio(draft, { file: 'mkjf_audio', label: '播放', play: 'auto' });
  addCardRef(draft, ['root_a'], '参见');
  const compiled = compileDraft(draft);
  assert.match(compiled.content, /\[Choice#fixed,multi#/);
  assert.match(compiled.content, /\[P#L,I2#二\]/);
  assert.match(compiled.content, /\[E##k=\[F#1#\\frac\{1\}\{2\}\]\]/);
  assert.match(compiled.content, /\[E##x\^2\]/);
  assert.match(compiled.content, /\[Pic#ID\/mkjf_img,MID\/mkjf_mask#\]/);
  assert.match(compiled.content, /\[Audio#A,ID\/mkjf_audio#播放\]/);
  assert.match(compiled.content, /\[Card#ID\/root_a#参见\]/);
});

test('buildMask normalizes pixel rectangles and parseImageSize reads PNG', () => {
  const mask = buildMask([{ x1: 100, y1: 200, x2: 400, y2: 300 }], 1000, 800);
  assert.deepEqual(mask, [{ width: 3000, height: 1250, top: 2500, left: 1000, index: 1, type: 'rect' }]);
  const png = Buffer.alloc(24);
  png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(parseImageSize(png), { width: 640, height: 480, format: 'png' });
  assert.throws(() => buildMask([{ x1: 0, y1: 0, x2: 2000, y2: 10 }], 1000, 800), /outside/);
});

test('editor and syntax tools are registered and work without a network for drafts', async () => {
  const engine = fakeEngine();
  const registered = fakeTools(engine, null);
  assert.equal(TOOL_NAMES.length, 18);
  assert.equal(registered.size, 18);
  const editor = registered.get('markji_card_editor');
  const syntax = registered.get('markji_card_syntax');
  let draft = await editor.execute({ action: 'new', deck: 'deck1', chapter: 'chap1' });
  assert.ok(draft.draft_id.startsWith('draft_'));
  await editor.execute({ action: 'type', draft: draft.draft_id, text: '问题？' });
  await editor.execute({ action: 'answer_line', draft: draft.draft_id });
  await editor.execute({ action: 'type', draft: draft.draft_id, text: '答案。' });
  const preview = await editor.execute({ action: 'preview', draft: draft.draft_id });
  assert.equal(preview.ok, true);
  assert.match(preview.content, /问题？\n---\n答案。/);
  const saved = await editor.execute({ action: 'save', draft: draft.draft_id });
  assert.equal(saved.card_id, 'local_cd_syntax_test');
  assert.equal(engine.calls.length, 1);
  await assert.rejects(() => editor.execute({ action: 'save', draft: draft.draft_id }), /already saved/);

  const guide = await syntax.execute({ action: 'guide' });
  assert.equal(Array.isArray(guide.guide.hard_rules), true);
  const escaped = await syntax.execute({ action: 'escape', text: 'a[b]' });
  assert.equal(escaped.escaped, 'a\\[b\\]');
  const validated = await syntax.execute({ action: 'validate', content: '[X##bad]' });
  assert.equal(validated.ok, false);
  const compiled = await syntax.execute({ action: 'compile', spec: { pages: [[{ type: 'paragraph', text: '问题' }], [{ type: 'paragraph', text: '答案' }]] } });
  assert.equal(compiled.ok, true);
  assert.match(compiled.content, /问题\n---\n答案/);
  const simple = await syntax.execute({ action: 'simple', front: '问题 [字面]', back: '答案' });
  assert.equal(simple.ok, true);
  assert.ok(simple.content.includes('问题 \\[字面\\]'), 'simple compiler escapes literal brackets: ' + simple.content);
  assert.match(simple.content, /\n---\n答案/);
});

test('create and update accept front/back, spec, or raw content', async () => {
  const engine = fakeEngine();
  const registered = fakeTools(engine, null);
  const create = registered.get('markji_card_create');
  const update = registered.get('markji_card_update');
  await create.execute({ deck: 'deck1', chapter: 'chap1', front: '问题？', back: '答案。' });
  assert.match(engine.calls[0].content, /问题？\n---\n答案。/);
  await create.execute({ deck: 'deck1', chapter: 'chap1', title: '标题', front: '问题？' });
  assert.match(engine.calls[1].content, /\[P#H1,center#\[T#B#标题\]\]/);
  await create.execute({ deck: 'deck1', chapter: 'chap1', spec: { pages: [[{ type: 'paragraph', text: 'S' }]] } });
  assert.equal(engine.calls[2].content, 'S');
  await update.execute({ card: 'card1', front: '改后问题', back: '改后答案' });
  assert.match(engine.calls[3].content, /改后问题\n---\n改后答案/);
  await update.execute({ card: 'card1', content: '[T#B#原样]' });
  assert.equal(engine.calls[4].content, '[T#B#原样]');
  await assert.rejects(() => create.execute({ deck: 'deck1', chapter: 'chap1' }), /provide content/);
});
