#[napi(js_name = "matchKeywords")]
pub fn match_keywords(text: String, keywords: Vec<String>) -> Vec<String> {
    keywords
        .into_iter()
        .filter(|keyword| text.contains(keyword))
        .collect()
}
