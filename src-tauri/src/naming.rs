use std::path::Path;

use crate::metadata::ExifSummary;

pub const DEFAULT_NAME_TEMPLATE: &str = "{prefix}{name}{suffix}";

pub fn default_name_template() -> String {
    DEFAULT_NAME_TEMPLATE.to_owned()
}

pub struct NamingContext<'a> {
    pub source: &'a Path,
    pub sequence: usize,
    pub prefix: &'a str,
    pub suffix: &'a str,
    pub metadata: &'a ExifSummary,
}

pub fn render_name_template(template: &str, context: &NamingContext<'_>) -> Result<String, String> {
    let template = template.trim();
    if template.is_empty() {
        return Err("파일 이름 템플릿은 비워둘 수 없습니다.".to_owned());
    }
    if template.chars().count() > 240 {
        return Err("파일 이름 템플릿은 240자 이하여야 합니다.".to_owned());
    }

    let source_name = context
        .source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut rendered = String::new();
    let mut remaining = template;

    while let Some(open) = remaining.find('{') {
        if remaining[..open].contains('}') {
            return Err("파일 이름 템플릿에 여는 중괄호가 없습니다.".to_owned());
        }
        rendered.push_str(&remaining[..open]);
        let token_start = &remaining[open + 1..];
        let close = token_start
            .find('}')
            .ok_or_else(|| "파일 이름 템플릿의 닫는 중괄호가 없습니다.".to_owned())?;
        let token = &token_start[..close];
        rendered.push_str(&render_token(token, source_name, context)?);
        remaining = &token_start[close + 1..];
    }
    if remaining.contains('}') {
        return Err("파일 이름 템플릿에 여는 중괄호가 없습니다.".to_owned());
    }
    rendered.push_str(remaining);

    let mut safe = sanitize_filename_fragment(&rendered);
    if safe.is_empty() {
        safe = "image".to_owned();
    }
    if is_windows_reserved_name(&safe) {
        safe.insert(0, '_');
    }
    Ok(safe.chars().take(180).collect())
}

fn render_token(
    token: &str,
    source_name: &str,
    context: &NamingContext<'_>,
) -> Result<String, String> {
    match token {
        "name" => Ok(source_name.to_owned()),
        "prefix" => Ok(context.prefix.to_owned()),
        "suffix" => Ok(context.suffix.to_owned()),
        "camera" => Ok(context
            .metadata
            .camera
            .as_deref()
            .unwrap_or("unknown-camera")
            .to_owned()),
        "lens" => Ok(context
            .metadata
            .lens
            .as_deref()
            .unwrap_or("unknown-lens")
            .to_owned()),
        "seq" => Ok(context.sequence.to_string()),
        _ if token.starts_with("seq:") => {
            let width = token[4..]
                .parse::<usize>()
                .map_err(|_| "순번 형식은 {seq:03}처럼 입력해주세요.".to_owned())?;
            if !(1..=8).contains(&width) {
                return Err("순번 자릿수는 1에서 8 사이여야 합니다.".to_owned());
            }
            Ok(format!("{:0width$}", context.sequence, width = width))
        }
        _ if token.starts_with("taken:") => {
            let pattern = &token[6..];
            format_taken_at(context.metadata.taken_at.as_deref(), pattern)
        }
        _ => Err(format!("지원하지 않는 파일 이름 토큰입니다: {{{token}}}")),
    }
}

fn format_taken_at(value: Option<&str>, pattern: &str) -> Result<String, String> {
    validate_date_pattern(pattern)?;
    let Some(value) = value else {
        return Ok("undated".to_owned());
    };
    if value.len() < 19 {
        return Ok("undated".to_owned());
    }
    let year = &value[0..4];
    let month = &value[5..7];
    let day = &value[8..10];
    let hour = &value[11..13];
    let minute = &value[14..16];
    let second = &value[17..19];
    let mut result = pattern.to_owned();
    for (token, replacement) in [
        ("yyyy", year),
        ("yy", &year[2..4]),
        ("MM", month),
        ("dd", day),
        ("HH", hour),
        ("mm", minute),
        ("ss", second),
    ] {
        result = result.replace(token, replacement);
    }
    Ok(result)
}

fn validate_date_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() || pattern.chars().count() > 40 {
        return Err("촬영일 형식은 1자 이상 40자 이하로 입력해주세요.".to_owned());
    }
    let mut remaining = pattern.to_owned();
    for token in ["yyyy", "yy", "MM", "dd", "HH", "mm", "ss"] {
        remaining = remaining.replace(token, "");
    }
    if remaining
        .chars()
        .any(|character| character.is_ascii_alphabetic())
    {
        return Err(
            "촬영일 형식에는 yyyy, yy, MM, dd, HH, mm, ss를 사용할 수 있습니다.".to_owned(),
        );
    }
    Ok(())
}

pub fn sanitize_filename_fragment(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ if character.is_control() => '_',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .to_owned()
}

fn is_windows_reserved_name(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> ExifSummary {
        ExifSummary {
            taken_at: Some("2026-08-22 15:04:09".to_owned()),
            camera: Some("FUJIFILM X-T5".to_owned()),
            lens: Some("XF23mmF2 R WR".to_owned()),
            orientation: 1,
            ..ExifSummary::default()
        }
    }

    #[test]
    fn renders_exif_date_and_padded_sequence() {
        let metadata = metadata();
        let context = NamingContext {
            source: Path::new("portrait.jpg"),
            sequence: 7,
            prefix: "cut_",
            suffix: "_bg",
            metadata: &metadata,
        };
        assert_eq!(
            render_name_template("{taken:yyMMdd_HHmmss}_{name}_{seq:03}", &context),
            Ok("260822_150409_portrait_007".to_owned())
        );
    }

    #[test]
    fn missing_exif_values_have_deterministic_fallbacks() {
        let metadata = ExifSummary::default();
        let context = NamingContext {
            source: Path::new("photo.jpg"),
            sequence: 1,
            prefix: "",
            suffix: "",
            metadata: &metadata,
        };
        assert_eq!(
            render_name_template("{taken:yyyyMMdd}_{camera}", &context),
            Ok("undated_unknown-camera".to_owned())
        );
    }

    #[test]
    fn rejects_unknown_tokens_and_reserved_names_are_made_safe() {
        let metadata = metadata();
        let context = NamingContext {
            source: Path::new("CON.jpg"),
            sequence: 1,
            prefix: "",
            suffix: "",
            metadata: &metadata,
        };
        assert_eq!(
            render_name_template("{name}", &context),
            Ok("_CON".to_owned())
        );
        assert!(render_name_template("{gps}", &context).is_err());
    }
}
