use std::{
    fs::File,
    io::{BufReader, Cursor, Read, Seek, SeekFrom},
    path::Path,
};

use exif::{experimental::Writer, DateTime, Field, In, Rational, Reader, Tag, Value};
use image::{metadata::Orientation, DynamicImage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExifSummary {
    pub taken_at: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub description: Option<String>,
    pub prompt: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub orientation: u8,
}

pub fn read_exif_summary(path: &Path) -> ExifSummary {
    let mut summary = ExifSummary {
        orientation: 1,
        ..ExifSummary::default()
    };
    if let Ok(file) = File::open(path) {
        let mut reader = BufReader::new(file);
        if let Ok(exif) = Reader::new().read_from_container(&mut reader) {
            summary.taken_at = [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime]
                .into_iter()
                .find_map(|tag| ascii_field(&exif, tag))
                .and_then(|value| parse_exif_datetime(&value));
            let make = ascii_field(&exif, Tag::Make);
            let model = ascii_field(&exif, Tag::Model);
            summary.camera = match (make, model) {
                (Some(make), Some(model))
                    if !model.to_lowercase().starts_with(&make.to_lowercase()) =>
                {
                    Some(format!("{make} {model}"))
                }
                (Some(make), Some(model)) if model.is_empty() => Some(make),
                (_, Some(model)) => Some(model),
                (Some(make), None) => Some(make),
                (None, None) => None,
            };
            summary.lens = ascii_field(&exif, Tag::LensModel);
            summary.description = ascii_field(&exif, Tag::ImageDescription);
            summary.prompt = user_comment_field(&exif);
            summary.gps_latitude = gps_coordinate(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef);
            summary.gps_longitude = gps_coordinate(&exif, Tag::GPSLongitude, Tag::GPSLongitudeRef);
            summary.orientation = exif
                .get_field(Tag::Orientation, In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
                .and_then(|value| u8::try_from(value).ok())
                .filter(|value| (1..=8).contains(value))
                .unwrap_or(1);
        }
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("png"))
    {
        let (description, prompt) = read_png_text_metadata(path);
        summary.description = summary.description.or(description);
        summary.prompt = summary.prompt.or(prompt);
    }
    summary
}

pub fn apply_orientation(image: &mut DynamicImage, orientation: u8) {
    if let Some(orientation) = Orientation::from_exif(orientation) {
        image.apply_orientation(orientation);
    }
}

pub fn safe_exif_profile(
    summary: &ExifSummary,
    preserve_gps: bool,
    preserve_prompt: bool,
) -> Result<Option<Vec<u8>>, String> {
    if preserve_gps {
        if let (Some(latitude), Some(longitude)) = (summary.gps_latitude, summary.gps_longitude) {
            if !latitude.is_finite()
                || !longitude.is_finite()
                || !(-90.0..=90.0).contains(&latitude)
                || !(-180.0..=180.0).contains(&longitude)
            {
                return Err("GPS coordinates are outside the valid range".to_owned());
            }
        }
    }
    if summary.taken_at.is_none()
        && summary.camera.is_none()
        && summary.lens.is_none()
        && summary.description.is_none()
        && (!preserve_prompt || summary.prompt.is_none())
        && (!preserve_gps || summary.gps_latitude.is_none() || summary.gps_longitude.is_none())
    {
        return Ok(None);
    }
    let mut fields = Vec::new();
    if let Some(taken_at) = summary.taken_at.as_deref().and_then(to_exif_datetime) {
        fields.push(Field {
            tag: Tag::DateTimeOriginal,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![taken_at.into_bytes()]),
        });
    }
    if let Some(camera) = summary.camera.as_deref() {
        fields.push(Field {
            tag: Tag::Model,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![camera.as_bytes().to_vec()]),
        });
    }
    if let Some(lens) = summary.lens.as_deref() {
        fields.push(Field {
            tag: Tag::LensModel,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![lens.as_bytes().to_vec()]),
        });
    }
    if let Some(description) = summary.description.as_deref() {
        fields.push(Field {
            tag: Tag::ImageDescription,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![description.as_bytes().to_vec()]),
        });
    }
    if preserve_prompt {
        if let Some(prompt) = summary.prompt.as_deref() {
            let mut encoded = b"ASCII\0\0\0".to_vec();
            encoded.extend_from_slice(prompt.as_bytes());
            fields.push(Field {
                tag: Tag::UserComment,
                ifd_num: In::PRIMARY,
                value: Value::Undefined(encoded, 0),
            });
        }
    }
    if preserve_gps {
        if let (Some(latitude), Some(longitude)) = (summary.gps_latitude, summary.gps_longitude) {
            fields.extend(gps_fields(latitude, longitude));
        }
    }
    fields.push(Field {
        tag: Tag::Orientation,
        ifd_num: In::PRIMARY,
        value: Value::Short(vec![1]),
    });
    let mut writer = Writer::new();
    for field in &fields {
        writer.push_field(field);
    }
    let mut encoded = Cursor::new(Vec::new());
    writer
        .write(&mut encoded, false)
        .map_err(|error| format!("출력 EXIF를 만들지 못했습니다: {error}"))?;
    Ok(Some(encoded.into_inner()))
}

fn user_comment_field(exif: &exif::Exif) -> Option<String> {
    let field = exif.get_field(Tag::UserComment, In::PRIMARY)?;
    let Value::Undefined(bytes, _) = &field.value else {
        return None;
    };
    let content = if bytes.starts_with(b"ASCII\0\0\0") {
        &bytes[8..]
    } else {
        bytes.as_slice()
    };
    let value = String::from_utf8_lossy(content)
        .trim_matches(char::from(0))
        .trim()
        .to_owned();
    (!value.is_empty()).then_some(value)
}

fn gps_coordinate(exif: &exif::Exif, value_tag: Tag, reference_tag: Tag) -> Option<f64> {
    let field = exif.get_field(value_tag, In::PRIMARY)?;
    let Value::Rational(parts) = &field.value else {
        return None;
    };
    if parts.len() < 3 || parts[..3].iter().any(|part| part.denom == 0) {
        return None;
    }
    let decimal = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    let reference = ascii_field(exif, reference_tag)?.to_ascii_uppercase();
    Some(if reference == "S" || reference == "W" {
        -decimal
    } else {
        decimal
    })
}

fn gps_fields(latitude: f64, longitude: f64) -> Vec<Field> {
    vec![
        Field {
            tag: Tag::GPSLatitudeRef,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![if latitude < 0.0 {
                b"S".to_vec()
            } else {
                b"N".to_vec()
            }]),
        },
        Field {
            tag: Tag::GPSLatitude,
            ifd_num: In::PRIMARY,
            value: Value::Rational(decimal_to_dms(latitude)),
        },
        Field {
            tag: Tag::GPSLongitudeRef,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![if longitude < 0.0 {
                b"W".to_vec()
            } else {
                b"E".to_vec()
            }]),
        },
        Field {
            tag: Tag::GPSLongitude,
            ifd_num: In::PRIMARY,
            value: Value::Rational(decimal_to_dms(longitude)),
        },
    ]
}

fn decimal_to_dms(value: f64) -> Vec<Rational> {
    let absolute = value.abs();
    let degrees = absolute.floor();
    let minutes_full = (absolute - degrees) * 60.0;
    let minutes = minutes_full.floor();
    let seconds = (minutes_full - minutes) * 60.0;
    vec![
        Rational {
            num: degrees as u32,
            denom: 1,
        },
        Rational {
            num: minutes as u32,
            denom: 1,
        },
        Rational {
            num: (seconds * 1_000_000.0).round() as u32,
            denom: 1_000_000,
        },
    ]
}

fn read_png_text_metadata(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(mut file) = File::open(path) else {
        return (None, None);
    };
    let mut signature = [0_u8; 8];
    if file.read_exact(&mut signature).is_err() || &signature != b"\x89PNG\r\n\x1a\n" {
        return (None, None);
    }
    let mut description = None;
    let mut prompts = Vec::new();
    loop {
        let mut length_bytes = [0_u8; 4];
        if file.read_exact(&mut length_bytes).is_err() {
            break;
        }
        let length = u32::from_be_bytes(length_bytes) as usize;
        let mut kind = [0_u8; 4];
        if file.read_exact(&mut kind).is_err() {
            break;
        }
        if length > 16 * 1024 * 1024 {
            if file.seek(SeekFrom::Current(length as i64 + 4)).is_err() {
                break;
            }
            continue;
        }
        let mut data = vec![0_u8; length];
        if file.read_exact(&mut data).is_err() || file.seek(SeekFrom::Current(4)).is_err() {
            break;
        }
        let entry = match &kind {
            b"tEXt" => parse_png_text(&data),
            b"iTXt" => parse_png_itxt(&data),
            b"IEND" => break,
            _ => None,
        };
        if let Some((key, value)) = entry {
            let normalized = key.to_ascii_lowercase();
            if matches!(normalized.as_str(), "parameters" | "prompt" | "workflow") {
                prompts.push(format!("{key}: {value}"));
            } else if description.is_none()
                && matches!(normalized.as_str(), "description" | "comment")
            {
                description = Some(value);
            }
        }
    }
    let prompt = (!prompts.is_empty()).then(|| prompts.join("\n\n"));
    (description, prompt)
}

fn parse_png_text(data: &[u8]) -> Option<(String, String)> {
    let separator = data.iter().position(|byte| *byte == 0)?;
    text_entry(&data[..separator], &data[separator + 1..])
}

fn parse_png_itxt(data: &[u8]) -> Option<(String, String)> {
    let keyword_end = data.iter().position(|byte| *byte == 0)?;
    let keyword = &data[..keyword_end];
    let rest = data.get(keyword_end + 1..)?;
    if rest.len() < 2 || rest[0] != 0 {
        return None;
    }
    let language_end = rest[2..].iter().position(|byte| *byte == 0)? + 2;
    let translated_start = language_end + 1;
    let translated_end = rest[translated_start..]
        .iter()
        .position(|byte| *byte == 0)?
        + translated_start;
    text_entry(keyword, &rest[translated_end + 1..])
}

fn text_entry(key: &[u8], value: &[u8]) -> Option<(String, String)> {
    let key = String::from_utf8_lossy(key).trim().to_owned();
    let value = String::from_utf8_lossy(value)
        .trim()
        .chars()
        .take(1_000_000)
        .collect::<String>();
    (!key.is_empty() && !value.is_empty()).then_some((key, value))
}

fn to_exif_datetime(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b' ' {
        return None;
    }
    Some(format!("{}:{}:{}", &value[0..4], &value[5..7], &value[8..]))
}

fn ascii_field(exif: &exif::Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    let Value::Ascii(values) = &field.value else {
        return None;
    };
    values.first().and_then(|bytes| {
        let value = String::from_utf8_lossy(bytes)
            .trim_matches(char::from(0))
            .trim()
            .to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn parse_exif_datetime(value: &str) -> Option<String> {
    let parsed = DateTime::from_ascii(value.as_bytes()).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use exif::{experimental::Writer, Field};
    use std::io::Cursor;

    #[test]
    fn exif_datetime_is_normalized_for_the_ui_and_naming_engine() {
        assert_eq!(
            parse_exif_datetime("2026:08:22 15:04:09"),
            Some("2026-08-22 15:04:09".to_owned())
        );
    }

    #[test]
    fn invalid_exif_datetime_is_ignored() {
        assert_eq!(parse_exif_datetime("not-a-date"), None);
    }

    #[test]
    fn recognizes_common_png_generation_text_keys() {
        assert_eq!(
            parse_png_text(b"parameters\0portrait, soft light"),
            Some(("parameters".to_owned(), "portrait, soft light".to_owned()))
        );
        assert_eq!(
            parse_png_itxt(b"workflow\0\0\0\0\0{\"nodes\":[]}"),
            Some(("workflow".to_owned(), "{\"nodes\":[]}".to_owned()))
        );
    }

    #[test]
    fn safe_output_profile_keeps_summary_and_normalizes_orientation() {
        let summary = ExifSummary {
            taken_at: Some("2026-08-22 15:04:09".to_owned()),
            camera: Some("CrystalCut Camera One".to_owned()),
            lens: Some("Prime 35mm".to_owned()),
            orientation: 6,
            ..ExifSummary::default()
        };
        let profile = safe_exif_profile(&summary, false, false)
            .expect("create safe profile")
            .expect("profile exists");
        let exif = Reader::new().read_raw(profile).expect("read safe profile");
        assert_eq!(
            ascii_field(&exif, Tag::DateTimeOriginal).as_deref(),
            Some("2026:08:22 15:04:09")
        );
        assert_eq!(
            ascii_field(&exif, Tag::Model).as_deref(),
            Some("CrystalCut Camera One")
        );
        assert_eq!(
            exif.get_field(Tag::Orientation, In::PRIMARY)
                .and_then(|field| field.value.get_uint(0)),
            Some(1)
        );
        assert!(exif.get_field(Tag::GPSLatitude, In::PRIMARY).is_none());
    }

    #[test]
    fn custom_output_profile_can_include_gps_and_prompt() {
        let summary = ExifSummary {
            prompt: Some("studio portrait, soft light".to_owned()),
            gps_latitude: Some(37.5665),
            gps_longitude: Some(126.9780),
            ..ExifSummary::default()
        };
        let profile = safe_exif_profile(&summary, true, true)
            .expect("create custom profile")
            .expect("profile exists");
        let exif = Reader::new()
            .read_raw(profile)
            .expect("read custom profile");
        assert_eq!(
            user_comment_field(&exif).as_deref(),
            Some("studio portrait, soft light")
        );
        assert!(
            (gps_coordinate(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef).unwrap() - 37.5665).abs()
                < 0.000_01
        );
        assert!(
            (gps_coordinate(&exif, Tag::GPSLongitude, Tag::GPSLongitudeRef).unwrap() - 126.9780)
                .abs()
                < 0.000_01
        );
    }

    #[test]
    fn output_profile_rejects_invalid_gps_coordinates() {
        let summary = ExifSummary {
            gps_latitude: Some(91.0),
            gps_longitude: Some(126.9780),
            ..ExifSummary::default()
        };
        assert!(safe_exif_profile(&summary, true, false).is_err());
        assert!(safe_exif_profile(&summary, false, false).is_ok());
    }

    #[test]
    fn reads_supported_exif_summary_fields() {
        let fields = [
            Field {
                tag: Tag::DateTimeOriginal,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"2026:08:22 15:04:09".to_vec()]),
            },
            Field {
                tag: Tag::Make,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"CrystalCut".to_vec()]),
            },
            Field {
                tag: Tag::Model,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"Camera One".to_vec()]),
            },
            Field {
                tag: Tag::LensModel,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"Prime 35mm".to_vec()]),
            },
            Field {
                tag: Tag::Orientation,
                ifd_num: In::PRIMARY,
                value: Value::Short(vec![6]),
            },
        ];
        let mut writer = Writer::new();
        for field in &fields {
            writer.push_field(field);
        }
        let mut encoded = Cursor::new(Vec::new());
        writer
            .write(&mut encoded, false)
            .expect("write EXIF fixture");
        let path = std::env::temp_dir().join(format!(
            "crystalcut-exif-summary-{}.tiff",
            std::process::id()
        ));
        std::fs::write(&path, encoded.into_inner()).expect("save EXIF fixture");

        let summary = read_exif_summary(&path);
        assert_eq!(summary.taken_at.as_deref(), Some("2026-08-22 15:04:09"));
        assert_eq!(summary.camera.as_deref(), Some("CrystalCut Camera One"));
        assert_eq!(summary.lens.as_deref(), Some("Prime 35mm"));
        assert_eq!(summary.orientation, 6);

        std::fs::remove_file(path).expect("remove EXIF fixture");
    }
}
