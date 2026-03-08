#[napi(js_name = "countTokens")]
pub fn count_tokens(text: String) -> u32 {
    let char_count = text.chars().count();
    if char_count == 0 {
        return 0;
    }

    char_count.div_ceil(4) as u32
}

#[napi(js_name = "countTokensBatch")]
pub fn count_tokens_batch(texts: Vec<String>) -> Vec<u32> {
    texts.into_iter().map(count_tokens).collect()
}
