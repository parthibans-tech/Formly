import { redirect } from "next/navigation";

// /settings is a navigation hub, not a real page — the breadcrumb
// auto-builder produces a link to /settings whenever you're deeper in
// the tree (e.g. /settings/organization). Without this file Next would
// 404 that link. Redirect to the account page, which every user can
// see; admin-only sections (organization, billing, audit, etc.) are
// reached from the sidebar.
export default function SettingsIndex() {
  redirect("/settings/account");
}
