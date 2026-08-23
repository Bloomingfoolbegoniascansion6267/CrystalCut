# Privacy policy

Last updated: August 23, 2026

This policy applies to the CrystalCut desktop application and the official
release files published from <https://github.com/pkh31337/CrystalCut>.

## Summary

CrystalCut is a local-first image-processing application. Source images,
previews, masks, image metadata, and exported results are processed on the
user's computer. CrystalCut does not operate an image-processing server and
does not upload these files to the maintainer or to a remote AI service.

CrystalCut does not include advertising, analytics, behavioral tracking,
telemetry, or an application account system.

## Data processed locally

Depending on the features used, CrystalCut may read and process the following
information on the user's device:

- source image contents and file-system paths;
- image dimensions, format, orientation, and file size;
- selected EXIF fields, including capture time, camera, lens, description,
  generation prompt or workflow information, and GPS coordinates;
- object-selection strokes, generated masks, edge settings, rotation, resize,
  naming, format, compression, and output settings; and
- output paths and processing status.

This information is used only to provide the functions requested in the
application. Source files are not modified by metadata editing or export
operations. Exported files are written only to locations selected through the
application's output settings.

## Local storage

CrystalCut stores application state in its operating-system application data
directory. The path is displayed in the application's Settings screen. Local
state can include:

- `workspace.sqlite3`, containing the work list, file paths, processing
  settings, per-file edits, and recovery state;
- application preferences and reusable output presets; and
- downloaded AI model files and incomplete-download temporary files.

Exported images are stored in the output directories selected by the user.
CrystalCut does not silently overwrite an existing output file.

The work list can be cleared from CrystalCut without deleting source or output
images. Installed AI models can also be removed from Settings. Uninstalling the
application may leave its application data directory behind, depending on the
operating system and installer behavior; users can delete that directory
manually after confirming they no longer need the saved workspace or models.

## Network access and AI models

CrystalCut makes no network request to process a user's image. Network access
is used only when a required AI model is not already installed and the user
requests installation or starts the related AI feature.

The current model download locations are:

- GitHub Releases, for the U2NetP background-removal model; and
- Hugging Face, for the SlimSAM encoder and decoder models used by guided
  object selection.

Model downloads are pinned to documented locations and are verified using
expected file sizes and SHA-256 hashes before use. The downloaded model hosts
receive the ordinary connection information involved in an HTTPS request,
such as the user's IP address and request metadata, under their own privacy
policies:

- [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
- [Hugging Face Privacy Policy](https://huggingface.co/privacy)

No source image, mask, image metadata, filename, or output image is included in
these model-download requests.

## Metadata choices

CrystalCut lets users choose which metadata is written to an exported image.
GPS coordinates and recognized generation prompts are separate opt-in output
choices and are disabled by default. Metadata edits affect newly exported
files only and do not alter the source image.

Users are responsible for reviewing exported metadata before sharing a file,
especially when enabling GPS or generation-prompt preservation.

## Information voluntarily shared through GitHub

If a user opens a GitHub issue, discussion, or other repository contribution,
the information they submit is processed by GitHub under GitHub's privacy
terms and may be publicly visible. Users should not attach private source
images, credentials, precise location data, or other sensitive information to
a public report.

CrystalCut does not automatically collect or transmit crash reports or
diagnostic data. Diagnostic information is shared with the maintainer only
when a user chooses to copy and submit it.

## Changes to this policy

Material changes to CrystalCut's data handling will be documented in this
file. The date at the top of the policy will be updated when the policy
changes.

## Contact

CrystalCut is maintained by Park Kyungho. Privacy questions can be submitted
through the [CrystalCut issue tracker](https://github.com/pkh31337/CrystalCut/issues).
Do not include confidential information in a public issue.

