-- Adds a new 'image' template engine mode.
--
-- 'image' templates wrap a raster file (PNG / JPEG / GIF / BMP / TIFF /
-- WebP) so it can be opened in the image designer — crop, rotate, flip,
-- resize, HD upscale, brightness/contrast/saturation, filters, format
-- and quality re-encode. The transform pipeline runs server-side via
-- github.com/disintegration/imaging (see api/internal/images/images.go).
--
-- There's no template_fields or config-derived schema: an image has no
-- placeholders. The whole editing surface is the image bytes themselves,
-- which live in the files table just like every other mode's source.
-- config_json carries the source mime + storage key so the designer can
-- default the export format back to the original.
--
-- Existing modes are unchanged.

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_mode_check;
ALTER TABLE templates ADD CONSTRAINT templates_mode_check
    CHECK (mode IN ('acroform','static','html','markdown','doc','image'));
