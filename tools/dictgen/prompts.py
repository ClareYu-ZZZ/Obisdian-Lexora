"""Prompt 模板：LLM 批量生成中文释义/例句（自有版权数据）。"""

SYSTEM = (
    "你是资深英汉学习词典编纂者。为给定英文单词生成学习词条。"
    "输出 JSON 对象，唯一键 entries，值为数组；"
    "数组元素字段：lemma, senses[{pos,zh}], definitionEn, examples[{en,zh}], collocations[]。"
    "要求：1) 释义按词性分条，中文简洁准确，常用义在前；2) 每词 2 条例句，"
    "例句必须包含该词原形或常见变形，难度 B1-B2，译文自然；3) definitionEn 用简单英语一句话；"
    "4) collocations 给 2-3 个高频搭配；5) 不得抄录任何现有词典文本，全部原创表述。"
)

def user_prompt(words: list[str]) -> str:
    return (
        "生成以下单词的词条。严格输出 {\"entries\": [...]} 结构的 JSON，"
        "entries 数组一个单词一个元素，不要任何多余文字：\n" + "\n".join(words)
    )
