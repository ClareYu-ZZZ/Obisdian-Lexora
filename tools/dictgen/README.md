# Lexora dictgen — 自建词库管线（设计文档 §8）

目标：一套权属清晰的英汉学习词库，商用安全。来源：WordNet/CMUdict/wordfreq（开放许可）+ LLM 原创中文释义与例句（自有版权）。

## 流程

```bash
# 1. 准备词表（word<TAB>tags，一词一行），见 wordlists/demo.txt
# 2. LLM 生成（任何 OpenAI 兼容端点）
OPENAI_API_KEY=sk-xxx python generate.py wordlists/cet6.txt --model gpt-4o-mini
# 3. 校验 + 构建分片（可选安装：pip install cmudict wordfreq）
python build_shards.py
# 4. out/dict-cache/ 覆盖到 vault 的 English/dict-cache/ → 插件即用自建词库
```

- `--demo` 走离线占位词条，先验证整条管线。
- 质量闸门：schema 校验、例句含目标词检查；高频 5000 词建议人工全量过一遍。
- 增量：raw/ 按批次缓存，重跑自动跳过已有批次；版本号写入 meta.json。
- examples.json 为例句库（P4 接入卡片随机例句）。
