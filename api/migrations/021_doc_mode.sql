-- Adds a new 'doc' template engine mode.
--
-- 'doc' templates store their source as a JSON AST (see
-- api/internal/generate/doc/ast.go) instead of HTML + Go template syntax.
-- The AST describes typed blocks (paragraph / heading / list / repeat / if /
-- field) which the server walks and renders to HTML directly — bypassing
-- html/template entirely. The result is:
--   - no pipe-semantics surprises (formatters are structured, not strings)
--   - no split control flow (a repeat block contains its children)
--   - inline error display pinned to AST node IDs
--
-- Existing 'html' / 'markdown' / 'acroform' / 'static' modes are unchanged.
-- Storage: source bytes still live in the files table; for doc mode the
-- bytes are a JSON document of shape {"version":1,"doc":{…}}.

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_mode_check;
ALTER TABLE templates ADD CONSTRAINT templates_mode_check
    CHECK (mode IN ('acroform','static','html','markdown','doc'));
