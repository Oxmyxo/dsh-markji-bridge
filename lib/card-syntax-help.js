// dsh-markji-bridge: static help for raw Markji card syntax.
//
// The help action is deliberately data-only: it explains the syntax that the
// validator accepts and never inspects or rewrites card content. The wording is
// based on the measured guide at SYNTAX_SOURCE and the OpenAPI card guide.

export const SYNTAX_SOURCE = 'https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/';
export const SYNTAX_HELP_VERSION = 1;

const RULES = [
  '一张卡的 content 是一整段 Markji 富文本；普通文字直接写，只有需要样式、挖空、选择题、公式或媒体时才使用标签。',
  '通用结构是 [名称#参数1,参数2#内容]；没有参数时也要保留两个 #，例如 [E##x+y]、[Choice##...]。',
  '标签名和参数区分大小写；多个参数用半角逗号分隔，标签名、参数和分隔符之间不要加空格。',
  '每个标签都必须以未转义的 ] 结束；普通文字中要显示中括号时写成 \\[ 和 \\]。',
  '必须保留真实换行：普通换行会产生新段落。P、Choice、Pic、独立 E 和 --- 必须从新一行的第一个字符开始。',
  '除明确允许的嵌套（P 内的行内语法、Choice 选项内的 T/E、E 内的公式挖空 F）外，不要嵌套语法。',
  '--- 是答案线，不是装饰分隔符；必须单独占一行，前后不要放其他文字。',
  '不要用 HTML、Markdown 标题或代码块代替 Markji 语法；无法确认的语法先用纯文本。',
  '媒体和卡片引用只能填 Markji 真实的 file.id / root_id；不要填文件名、本地路径、URL 或猜测的 ID。',
  '正文上限为 100000 字符；create/update 会自动校验语法和媒体引用，syntax_help 只返回语法说明，不检查 content。',
];

const NESTING = [
  { container: '普通段落', allowed: ['T', 'F', 'Audio', 'Card', '行内 E'] },
  { container: 'P 段落', allowed: ['T', 'F', 'Audio', 'Card'] },
  { container: 'Choice 选项', allowed: ['T', 'E'] },
  { container: 'T / F 的内容', allowed: [] },
  { container: 'Audio / Card 的显示文字', allowed: [] },
  { container: 'Pic', allowed: [] },
  { container: 'E 公式内容', allowed: ['KaTeX/LaTeX 内容', 'F（公式挖空）'] },
];

const FORMATS = [
  {
    format: 'text-style',
    aliases: ['text', 'style', 't', '文字样式', '样式', '文本样式'],
    name: '文字样式',
    tag: 'T',
    kind: 'inline',
    summary: '给一段文字加粗、斜体、颜色、上下标或链接；同一段文字的多重样式合并到一个 T 标签。',
    syntax: '[T#样式参数#文字]',
    parameters: [
      { name: 'B', description: '加粗' },
      { name: 'I', description: '斜体' },
      { name: 'U', description: '下划线' },
      { name: 'D', description: '删除线' },
      { name: '!rrggbb', description: '文字颜色，6 位小写十六进制，不带 #，例如 !ff2600' },
      { name: '!!rrggbb', description: '背景颜色，例如 !!fff2cc' },
      { name: 'up', description: '上标，例如 x[T#up#2]' },
      { name: 'down', description: '下标，例如 H[T#down#2]O' },
      { name: 'link/"URL"', description: '网页链接；URL 必须用英文双引号，含 # 或逗号时先 URL 编码' },
    ],
    examples: [
      '[T#B#重点]',
      '[T#B,U,!ff2600#需要特别记忆的内容]',
      '[T#link/"https://example.com"#查看网页]',
    ],
    notes: [
      '多个样式用英文逗号合并，推荐顺序：B,U,I,D,up,down,!文字颜色,!!背景颜色,link/"URL"。',
      'up 和 down 不能同时使用；同一种参数不要重复，多个颜色或对齐方式也不要冲突。',
      'T 的内容中不能再放其他语法；多重样式不要写成多层嵌套的 T。',
      '颜色值必须是小写六位十六进制，且参数前只写一个 ! 或 !!，不要写成 !#ff0000。',
    ],
  },
  {
    format: 'cloze',
    aliases: ['f', '挖空', '填空'],
    name: '挖空',
    tag: 'F',
    kind: 'inline',
    summary: '隐藏一段需要回忆的内容；相同编号属于同一组。',
    syntax: '[F#正整数编号#要隐藏的内容]',
    parameters: [{ name: '编号', description: '从 1 开始的正整数；相同编号属于同一组，会一起显示或隐藏' }],
    examples: ['光合作用主要发生在[F#1#叶绿体]中。'],
    notes: [
      '编号不能省略，也不能使用 0、负数、小数或文字编号。',
      '普通 F 的内容中不要嵌套其他标签；需要样式时把样式放在 F 外。',
      '公式挖空方向相反：把 F 放进 E，例如 [E##k=[F#1#\\frac{\\Delta y}{\\Delta x}]]，不要写成 [F#1#[E##...]]。',
    ],
  },
  {
    format: 'audio',
    aliases: ['a', '音频', '声音'],
    name: '音频',
    tag: 'Audio',
    kind: 'inline',
    summary: '引用一段已上传到 Markji 的音频，并设置播放行为。',
    syntax: '[Audio#参数,ID/音频ID#显示文字]',
    parameters: [
      { name: 'ID/<fileId>', description: '真实已有的音频 file.id（大小写敏感）' },
      { name: 'M', description: '手动播放' },
      { name: 'A', description: '自动播放；不写 M 时也按自动播放处理' },
      { name: 'D', description: '播放行为跟随用户设置' },
    ],
    examples: [
      '[Audio#M,ID/1kIC9#点击播放发音]',
      '[Audio#ID/1kIC9,D#单词发音]',
      '[Audio#A,ID/1kIC9#]',
    ],
    notes: [
      '只使用真实已有的音频 ID，不要猜测或编造；不要填写本地路径、文件名或 URL。',
      'M 和 A 不要同时使用；需要自动播放时可以省略 A。',
      '显示文字可以为空，但仍要保留第二个 #；显示文字中不要嵌套其他语法。',
    ],
  },
  {
    format: 'card-ref',
    aliases: ['card', 'cardref', 'card-reference', '卡片引用', '关联卡片', '引用卡片'],
    name: '卡片引用',
    tag: 'Card',
    kind: 'inline',
    summary: '链接到 Markji 中已有的卡片；目标是卡片真实的 root_id。',
    syntax: '[Card#ID/root_id#显示文字]',
    parameters: [
      { name: 'ID/<root_id>', description: '目标卡片的真实 root_id，不是 card.id、deck_id 或 file.id' },
      { name: '多个 root_id', description: '用半角短横线连接，最多 5 个，例如 ID/4wJYw-4wJYx' },
    ],
    examples: [
      '[Card#ID/4wJYw#参见相关卡片]',
      '[Card#ID/4wJYw-4wJYx#参见两张相关卡片]',
    ],
    notes: [
      'root_id 必须从真实卡片数据中取得，并逐字符原样保留。',
      '多个 root_id 之间只能使用短横线，不能使用逗号、空格或换行；当前最多关联 5 张。',
      '显示文字中不要嵌套其他语法；引用目标被删除或无权访问时可能无法打开。',
    ],
  },
  {
    format: 'paragraph',
    aliases: ['p', 'para', '段落', '段落样式', '标题'],
    name: '段落样式',
    tag: 'P',
    kind: 'block',
    summary: '设置标题、无序列表、缩进或对齐；普通段落不需要 P 标签。',
    syntax: '[P#段落样式#段落内容]',
    parameters: [
      { name: 'H1', description: '一级标题；只支持 H1' },
      { name: 'L', description: '无序列表项；当前只支持无序列表' },
      { name: 'I<n>', description: '缩进级别，n 为正整数，例如 I2' },
      { name: 'left / center / right', description: '对齐方式；一段只能选一种' },
    ],
    examples: [
      '[P#H1,center#细胞呼吸]',
      '[P#center#Cellular Respiration]',
      '[P#L,I2#线粒体]',
    ],
    notes: [
      'P 必须从新一行第一个字符开始；整个 P 尽量写在同一行。',
      '标题只使用 H1，不要生成其他标题级别；列表只使用 L，不要生成有序列表、折叠或行内代码。',
      '段落内容可以包含 T、F、Audio、Card，但这些行内语法之间不要互相嵌套；P 内不要放 Choice、Pic、E 等块级标签。',
      '普通段落直接写文字即可，不需要 [P##内容]。',
    ],
  },
  {
    format: 'choice',
    aliases: ['选择题', '选项'],
    name: '选择题',
    tag: 'Choice',
    kind: 'block',
    summary: '创建单选或多选选择题；正确答案由每行的 * / - 前缀决定。',
    syntax: '[Choice#参数#\n* 正确选项\n- 错误选项\n]',
    parameters: [
      { name: 'fixed', description: '固定选项顺序；省略时默认随机排列' },
      { name: 'multi', description: '多选题；多个正确选项时必须使用' },
      { name: 'fixed,multi', description: '固定顺序的多选题；两个参数用半角逗号组合' },
    ],
    examples: [
      '[Choice##\n* 线粒体\n- 叶绿体\n- 核糖体\n]',
      '[Choice#multi#\n* 氧气\n* 水\n- 氯化钠\n]',
      '[Choice#fixed,multi#\n* 鲸\n- 鲨鱼\n* 蝙蝠\n- 企鹅\n]',
    ],
    notes: [
      '[Choice... 必须从新一行开头，结束的 ] 必须单独占一行。',
      '每个选项必须单独一行，并准确使用 * 或 - 加一个半角空格；不要用其他方式声明答案。',
      '恰好一个 * 时使用 [Choice##；多于一个 * 时必须加 multi；单选不要加 multi。',
      '选项内只允许普通文字、T 和 E（例如公式选项）；不要放 F、Audio、Card 或 Pic。',
      '选择块结束后可用独占一行的 --- 分隔题目与解析。',
    ],
  },
  {
    format: 'picture',
    aliases: ['pic', 'image', 'img', '图片', '画廊', '遮罩'],
    name: '图片与遮罩',
    tag: 'Pic',
    kind: 'block',
    summary: '引用已上传的图片，可加图片遮罩；相邻图片可组成画廊。',
    syntax: '[Pic#ID/图片ID#]',
    parameters: [
      { name: 'ID/<fileId>', description: '原图真实已有的 file.id（大小写敏感）' },
      { name: 'MID/<fileId>', description: '可选遮罩文件的真实 file.id；必须写在 ID 之后' },
    ],
    examples: [
      '[Pic#ID/1kIBX#]',
      '[Pic#ID/1kIBX,MID/1kIBY#]',
      '[Pic#ID/1kIBX#][Pic#ID/1kIBY#]',
    ],
    notes: [
      'Pic 必须从新一行开头；内容区必须为空，所以结尾是 #]。',
      '带遮罩时参数顺序固定为 ID/<原图> 在前、MID/<遮罩> 在后，中间只用半角逗号，不能插入空格。',
      'MID 必须指向真实的遮罩文件（通常是 .msk1），不要误用预览图；没有遮罩时不要保留空的 MID。',
      '相邻且没有空格或换行的多张图片组成同一画廊；换行则形成独立图片区块。',
      '只使用真实已有的 file.id；ID 大小写敏感，不要填文件名、本地路径或 URL。',
    ],
  },
  {
    format: 'formula',
    aliases: ['e', 'equation', 'math', 'latex', '公式', '方程'],
    name: '公式',
    tag: 'E',
    kind: 'inline-or-block',
    summary: '用 KaTeX 渲染 LaTeX 公式；支持行内公式、独立公式和公式挖空。',
    syntax: '[E##公式]',
    parameters: [],
    examples: [
      '速度 [E##v] 是位移变化量 [E##\\Delta x] 与时间变化量 [E##\\Delta t] 的比值。',
      '[E##E_k=\\frac{1}{2}mv^2]',
      '[E##\\begin{aligned}\na^2+b^2&=c^2\n\\end{aligned}]',
      '[E##k=[F#1#\\frac{\\Delta y}{\\Delta x}]]',
    ],
    notes: [
      'E 固定使用两个 #；第二个 # 后直接写 KaTeX 支持的 LaTeX 内容。',
      '行内 E 可以出现在普通段落中；独立 E 必须从新一行开头，结束的 ] 后同一行不要再追加普通文字。',
      '公式内容可以换行；不要在 E 内部再套 $...$、$$...$$、\\(...\\) 或 \\[...\\] 等公式定界符。',
      '公式挖空把 F 放在 E 内部，写成 [E##公式前段[F#1#被挖空的 LaTeX]公式后段]，不要反向写成 [F#1#[E##...]]。',
      'E 内除公式挖空 F 外只写 LaTeX；题号、解释文字和括号说明放在 E 外。',
    ],
  },
  {
    format: 'answer-line',
    aliases: ['answer', 'separator', '---', '答案线', '答案分隔线', '分隔线'],
    name: '答案线',
    tag: '---',
    kind: 'block',
    summary: '用独占一行的三个半角连字符分隔提问面与回答面。',
    syntax: '---',
    parameters: [],
    examples: [
      '问题\n---\n答案',
      '标题\n---\n[Pic#ID/1kIBX#]\n---\n正文',
    ],
    notes: [
      '必须恰好是三个半角连字符，单独占一行，前后不要加空格或其他文字。',
      '--- 是答案线，不是装饰分隔符；一张卡可以按显示层次使用第二条答案线。',
      '不要改成其他横线、HTML 或 Markdown 分隔线；如果答案线位于卡片末尾，仍应保留它后面的真实换行。',
    ],
  },
];

const ALIAS_TO_FORMAT = new Map();
for (const entry of FORMATS) {
  ALIAS_TO_FORMAT.set(entry.format, entry.format);
  for (const alias of entry.aliases) ALIAS_TO_FORMAT.set(alias, entry.format);
}

const BASIC_ALIASES = new Set(['basic', 'basics', 'overview', 'structure', 'rules', '基础', '总览', '规则', '通用规则']);
const ALL_ALIASES = new Set(['all', '*', '全部', '所有']);

function normalizeFormat(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function publicEntry(entry) {
  return {
    format: entry.format,
    name: entry.name,
    tag: entry.tag,
    kind: entry.kind,
    summary: entry.summary,
    syntax: entry.syntax,
    parameters: entry.parameters,
    examples: entry.examples,
    notes: entry.notes,
  };
}

function availableFormats() {
  return FORMATS.map((entry) => ({ format: entry.format, tag: entry.tag, name: entry.name }));
}

function rulesResponse(format) {
  return {
    ok: true,
    action: 'help',
    format,
    help_version: SYNTAX_HELP_VERSION,
    source: SYNTAX_SOURCE,
    summary: 'Markji 卡片语法的通用规则、位置限制和嵌套限制。',
    rules: RULES,
    nesting: NESTING,
    available_formats: availableFormats(),
  };
}

function allResponse() {
  return {
    ok: true,
    action: 'help',
    format: 'all',
    help_version: SYNTAX_HELP_VERSION,
    source: SYNTAX_SOURCE,
    summary: 'Markji 卡片语法总览：通用规则、嵌套限制，以及全部已支持的格式。',
    rules: RULES,
    nesting: NESTING,
    formats: FORMATS.map(publicEntry),
    available_formats: availableFormats(),
  };
}

function unknownResponse(requested) {
  return {
    ok: false,
    action: 'help',
    format: requested,
    error: 'unknown_format',
    message: 'unknown syntax format: ' + requested,
    available_formats: availableFormats(),
  };
}

/**
 * Return static syntax help.
 *
 * On action=help, format may be omitted or 'all' for every format; a known
 * format id, tag or Chinese alias returns just that entry; 'basic' returns the
 * general rules and nesting matrix.
 */
export function getSyntaxHelp(format) {
  const normalized = normalizeFormat(format);
  if (normalized === '' || ALL_ALIASES.has(normalized)) return allResponse();
  if (BASIC_ALIASES.has(normalized)) return rulesResponse('basic');
  const canonical = ALIAS_TO_FORMAT.get(normalized);
  if (canonical === undefined) return unknownResponse(typeof format === 'string' ? format.trim() : String(format));
  const entry = FORMATS.find((candidate) => candidate.format === canonical);
  return {
    ok: true,
    action: 'help',
    format: entry.format,
    help_version: SYNTAX_HELP_VERSION,
    source: SYNTAX_SOURCE,
    ...publicEntry(entry),
    available_formats: availableFormats(),
  };
}
