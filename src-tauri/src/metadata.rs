use std::{fs::File, io::BufReader, path::Path};

use exif::{DateTime, In, Reader, Tag, Value};
use image::{metadata::Orientation, DynamicImage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifSummary {
    pub taken_at: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub orientation: u8,
}

pub fn read_exif_summary(path: &Path) -> ExifSummary {
    let Ok(file) = File::open(path) else {
        return ExifSummary::default();
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = Reader::new().read_from_container(&mut reader) else {
        return ExifSummary::default();
    };

    let taken_at = [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime]
        .into_iter()
        .find_map(|tag| ascii_field(&exif, tag))
        .and_then(|value| parse_exif_datetime(&value));
    let make = ascii_field(&exif, Tag::Make);
    let model = ascii_field(&exif, Tag::Model);
    let camera = match (make, model) {
        (Some(make), Some(model)) if !model.to_lowercase().starts_with(&make.to_lowercase()) => {
            Some(format!("{make} {model}"))
        }
        (Some(make), Some(model)) if model.is_empty() => Some(make),
        (_, Some(model)) => Some(model),
        (Some(make), None) => Some(make),
        (None, None) => None,
    };
    let lens = ascii_field(&exif, Tag::LensModel);
    let orientation = exif
        .get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1);

    ExifSummary {
        taken_at,
        camera,
        lens,
        orientation,
    }
}

pub fn apply_orientation(image: &mut DynamicImage, orientation: u8) {
    if let Some(orientation) = Orientation::from_exif(orientation) {
        image.apply_orientation(orientation);
    }
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
    fn reads_supported_fields_without_exposing_gps() {
        let fields = [
            Field {
                tag: Tag::DateTimeOriginal,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"2026:08:22 15:04:09".to_vec()]),
            },
            Field {
                tag: Tag::Make,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"Clearcut".to_vec()]),
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
        let path =
            std::env::temp_dir().join(format!("clearcut-exif-summary-{}.tiff", std::process::id()));
        std::fs::write(&path, encoded.into_inner()).expect("save EXIF fixture");

        let summary = read_exif_summary(&path);
        assert_eq!(summary.taken_at.as_deref(), Some("2026-08-22 15:04:09"));
        assert_eq!(summary.camera.as_deref(), Some("Clearcut Camera One"));
        assert_eq!(summary.lens.as_deref(), Some("Prime 35mm"));
        assert_eq!(summary.orientation, 6);

        std::fs::remove_file(path).expect("remove EXIF fixture");
    }
}
