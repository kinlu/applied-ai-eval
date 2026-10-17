# applied-ai-eval

按产品真实上线的方式评测 AI 应用：用 golden cases 跑你真实的生产链路，用确定性的“有据可查”检查给最终输出打分，每次改提示词、换模型、调参数之前，先拿候选版本和基线做对比。

[English](README.md)

```text
golden cases ──► 你的生产链路 ──► 最终输出 ──► 检查 + 闸门 + 陷阱 ──► report.json
（虚构、埋了陷阱）  （同样的提示词、协议、   （用户真正看到的）  （数字可追溯？照抄输入？        │
                  校验、降级路径）                          近重复？schema？）            ▼
                       基线运行 ─────────────────────────► aieval compare ◄──── 候选运行
                                                          每个指标给出判定，超出噪声才算数
```

## 为什么需要它

LLM 应用的退化往往悄无声息：提示词改得更“温暖”，回复就开始附和客户的错误说法；换了更便宜的模型，“从 10 天缩短到 6 天”变成了“6 天”；开了推理，judge 分数涨了一点，延迟却翻了几倍，请求开始超时，线上悄悄退回确定性降级路径。单元测试检查的是代码路径，公开榜单测的是模型，两者都不测你的应用到底给了用户什么。

这个工具测的就是这个，而且每次都能和上一次对比，让每个改动都带着一张前后对比表上线。

## 方法

1. **端到端评测生产链路。** 跑的是用户请求真正经过的那条路：同样的提示词、协议、校验器和后处理，量的是最终、用户可见的输出。每次只改一个变量。
2. **写“会失败”的 golden cases。** 用虚构、去标识化的输入覆盖用户真实带来的多样性，每个用例都埋陷阱：换了口径的数字、被说成决定的倾向、与参考资料矛盾的说法。
3. **在 cases 上调，在 hold-out 上验收。** hold-out 用例覆盖别的场景，只在改动结束时跑一次。看过 hold-out 的输出，这个用例就不再是盲测：要记录下来，并补充新用例。
4. **先做确定性检查。** 数字能追溯到输入、句子不用输入里从没出现的词、不照抄请求、不近重复、不丢掉基线和限定语。便宜、精确、可重复。
5. **先过闸门，再谈质量。** 违反协议的输出（schema 不合法、缺必需的工具调用、超时、语言不对）写得再好也不能用。
6. **多次采样，而不是跑一次。** 每格两次以上，才能分清结构性差异和采样噪声。
7. **LLM judge 放第二位，并测出它的噪声。** 固定 judge 模型，整数评分，基于保存下来的输出对基线和候选背靠背打分，并在相同输出上测出 judge 自身的波动。
8. **先对比，再决定。** 质量指标没有超出噪声的退化才采用。成本和延迟的变化是取舍，由人拿着数字决定接受与否。
9. **算清真实成本。** 用供应商实际计费的成本，算上隐藏的推理 token、失败的调用、降级，以及供应商实际返回的模型。
10. **保留所有产物。** 指标定义变了就重新打分，judge 换了就重新评判，不必重新生成。
11. **没有模型调用的运行只是冒烟测试**，不是质量信号，报告里要写明。
12. **写清楚哪些没有验证。**

每条规则背后的理由和教训见 [docs/methodology.md](docs/methodology.md)（英文）。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/kinlu/applied-ai-eval && cd applied-ai-eval
npm install                      # 同时构建 dist/

# 用两个提示词版本跑示例应用（一个虚构的客服回复草拟器）
node dist/cli.js run --config examples/support-reply/eval.config.mjs --variant baseline,friendly

# 对比两个版本：运行目录会在上一条命令的输出里给出
node dist/cli.js compare examples/support-reply/eval/reports/<run>#baseline \
                         examples/support-reply/eval/reports/<run>#friendly
```

示例默认离线运行，用确定性的替身代替模型，所以报告会标注为冒烟运行。其中“friendly”提示词附和了客户的错误说法、给回复注水、还做了帮助文章里没有的承诺，对比结果把这些都抓了出来：

```text
**Verdict: 8 quality regression(s)** — Runs with a failed gate (0 → 1); Numbers no source states (0 → 6);
Numbers traceable to a source (100.0% → 63.1%); Lines using words no source uses (0 → 18);
Near-duplicate line pairs (0 → 6); Lines echoing message (0 → 4); Traps failed (0 → 1);
Gate passed: trap:accepts-false-claim (100.0% → 0.0%).
```

配上任意 OpenAI 兼容的接口，同一个示例就能在真实模型上跑，见 [examples/support-reply](examples/support-reply/README.md)。

## 在你的项目里使用

```bash
npm install --save-dev github:kinlu/applied-ai-eval
npx aieval init        # 生成 eval.config.mjs、eval/app-adapter.mjs、一个示例用例，并把 eval/reports/ 加进 .gitignore
```

**1. 接上你的应用。** adapter 为一个用例调用你的生产代码，返回最终输出：

```js
// eval/app-adapter.mjs
import { draftReply } from '../src/reply.js';

export async function run({ caseId, inputs, variant, sample }, ctx) {
  const reply = await draftReply(inputs.message, inputs.kb, {
    ...variant.options,                          // 比如 { prompt: 'v2' } 或 { model: '...' }
    signal: ctx.signal,                          // 超时时会被中止
    onLlmCall: (call) => ctx.recordLlmCall(call) // token、成本、延迟、实际返回的模型
  });
  return {
    output: reply.text,                          // 用户看到的内容
    stages: { draft: { mode: reply.usedFallback ? 'fallback' : 'llm' } },
    gates: { schema_valid: reply.schemaValid },  // 应用本来就在做的协议检查
  };
}
```

其他语言的应用可以用命令行（`{ command: ['swift', 'run', 'EvalAdapter'] }`，stdin/stdout 传 JSON）或 HTTP 接口（`{ url: 'http://localhost:4000/eval' }`），见 [docs/adapters.md](docs/adapters.md)。

**2. 配置评测。**

```js
// eval.config.mjs
export default {
  name: 'support-reply',
  app: { module: './eval/app-adapter.mjs' },
  variants: { baseline: { prompt: 'v1' }, candidate: { prompt: 'v2' } },
  sources: ['kb', 'message'],   // 输出可以依据的输入
  echoOf: ['message'],          // 输出应该回答、而不是复述的输入
  checks: ['numeric-traceability', 'unsupported-lines', 'near-duplicates', 'input-echo',
           'misspellings', { check: 'json-shape', gate: true }, { check: 'length', max: 1200 }],
  judge: { dimensions: [{ key: 'grounded', description: 'Every claim is stated in the article.' }] },
};
```

**3. 写用例。** 每个用例一个目录，放在 `eval/cases/`（调参用）或 `eval/holdout/`（只用于验收）：

```text
eval/cases/refund-after-window/
├── case.json      标题、标签、说明、输入、陷阱、必须保留的事实、审核问题
├── message.txt    客户的消息
└── kb.md          帮助中心文章
```

陷阱的写法：尽量断言正确的说法（`mustInclude: ["30 days"]`），少去禁止错误的说法，因为正确的回复常常要引用错误说法来纠正它；正则遇到否定句很容易误判。字段和写法见 [docs/writing-cases.md](docs/writing-cases.md)。

**4. 跑、改、再跑、对比。**

```bash
npx aieval run --samples 2 --label before
# 改提示词、模型或参数
npx aieval run --samples 2 --label after
npx aieval compare eval/reports/<before> eval/reports/<after> --out compare.md --fail-on-regression
npx aieval run --holdout --variant candidate      # 最后跑一次，用于验收
```

## 每次运行写出什么

```text
eval/reports/<timestamp>[-holdout][-label]/
├── report.json        compare、judge、rescore 读取的全部数据
├── report.md          闸门、各 variant 汇总、成本与延迟、逐用例、陷阱、被标记的句子、按 agent 的用量
├── inputs.md          每个 variant 收到的完全相同的输入
├── review.md          人工审核清单：每个用例的陷阱和问题，附输出链接
└── artifacts/<case>/<variant>-s<sample>.{json,md}   每个输出、它的检查结果和 LLM 调用
```

报告里有模型输出，不要提交进 git（`aieval init` 会把 `eval/reports/` 加进 `.gitignore`）。

## 内置检查

| 检查 | 标记什么 |
|---|---|
| `numeric-traceability` | 输出里有、输入里没有的数字 |
| `unsupported-lines` | 用了任何输入都没出现过的实义词的句子（英文） |
| `near-duplicates` | 同一组内互相复述的句子对 |
| `input-echo` | 复述请求、而不是依据资料作答的句子 |
| `misspellings` | 与输入中某个词只差一处编辑的拼写错误，被空格拆开的词 |
| `baseline-drops` | 改进只留下结果、丢了起点（“从 10 天到 6 天”变成“6 天”） |
| `qualifier-drops` | 事实被去掉了时间范围或约数限定 |
| `reasoning-leak` | 模型的思考过程漏进了用户可见的文本 |
| `json-shape` | 本该是正文却返回了 JSON（可作为闸门） |
| `script-ratio` | 输出文字/语言不对，中文输出里夹着成段英文 |
| `length` | 输出长度，可设上下限作为闸门 |
| `schema` | 结构化输出不符合 JSON Schema（闸门） |

用例里声明的期望总会执行：`traps`（字面或正则断言，可设为闸门）、`keywords`、`carry`（输出必须保留的事实）。每次运行还会记录错误、超时、闸门、降级、LLM 调用、token、实际计费与按挂牌价估算的成本、延迟分位数和实际返回的模型。阈值和校准见 [docs/checks.md](docs/checks.md)。

## 命令行

```text
aieval run      [--config <file>] [--case a,b] [--tag t] [--holdout] [--variant a,b|all]
                [--samples N] [--label name] [--judge] [--concurrency N] [--timeout ms] [--reports <dir>]
aieval compare  <baseline-run>[#variant] <candidate-run>[#variant]
                [--out compare.md] [--fail-on-regression] [--judge-noise 0.16] [--tolerance key=value]...
aieval judge    <run> [--passes N] [--out <dir>]     # 事后用 LLM judge 打分，写入 <run>-judged/
aieval rescore  <run> [--out <dir>]                  # 用保存的输出重新计算检查
aieval holdout  status | seen <case> --note "原因"
aieval init     [dir]
```

`--fail-on-regression` 在质量指标超出噪声退化时以 1 退出，可以直接在 CI 里拦住改动。judge 读取 `AIEVAL_JUDGE_MODEL`、`AIEVAL_JUDGE_API_KEY`（或 `OPENAI_API_KEY`），用 `AIEVAL_JUDGE_BASE_URL` 指向任意 OpenAI 兼容接口。

## 文档

- [Methodology](docs/methodology.md)：规则、理由和背后的教训
- [Writing cases](docs/writing-cases.md)：用例格式、有效的陷阱写法、hold-out 规则、隐私
- [Checks](docs/checks.md)：每个检查的定义、阈值、校准和已知局限
- [Adapters](docs/adapters.md)：接入 TypeScript、Python、Swift 或 HTTP 应用
- [Judge](docs/judge.md)：评分维度设计、噪声、背靠背评判
- [Adopting it](docs/adopting.md)：写进仓库 AGENTS.md / CLAUDE.md 的规则、PR 清单、CI

## 来源

这套方法提炼自两个生产应用的评测实践：一个是简历定制 Web 应用（TypeScript），它的 eval 让每个 golden case 走完导入、定制、渲染的整条链路，配有 hold-out 集，在渲染后的输出上计算有据可查类指标，并要求每次改提示词或模型都附前后对比；另一个是端侧会议助手（Swift），它的模型对比在一场手写、埋了陷阱的会议上驱动应用真实的多 agent 会话，包含协议闸门、重复采样、含隐藏推理 token 的实际计费成本，以及人工审核包。

## 许可证

[MIT](LICENSE)
