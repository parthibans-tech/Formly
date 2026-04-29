import { invoiceStarter } from "./invoice";
import { receiptStarter } from "./receipt";
import { ndaStarter } from "./nda";
import { offerLetterStarter } from "./offer-letter";
import { certificateStarter } from "./certificate";
import { letterStarter } from "./letter";
import { resumeStarter } from "./resume";
import { meetingNotesStarter } from "./meeting-notes";
import { blankStarter } from "./blank";
import { proposalStarter } from "./proposal";
import { pressReleaseStarter } from "./press-release";
import { quoteStarter } from "./quote";
import { purchaseOrderStarter } from "./purchase-order";
import { sopStarter } from "./sop";
import { checklistStarter } from "./checklist";
import { eventInviteStarter } from "./event-invite";
import { eventTicketStarter } from "./event-ticket";
import { coverLetterStarter } from "./cover-letter";
import { statusReportStarter } from "./status-report";
import { performanceReviewStarter } from "./performance-review";
import { statementStarter } from "./statement";
import { syllabusStarter } from "./syllabus";
import { expenseReportStarter } from "./expense-report";
import { leaseAgreementStarter } from "./lease-agreement";
import type { Starter, StarterCategory } from "./types";

export const STARTERS: Starter[] = [
  // Billing
  invoiceStarter,
  receiptStarter,
  statementStarter,
  // Legal
  ndaStarter,
  leaseAgreementStarter,
  // HR
  offerLetterStarter,
  resumeStarter,
  performanceReviewStarter,
  // Certificates
  certificateStarter,
  // Correspondence
  letterStarter,
  coverLetterStarter,
  // Reports
  meetingNotesStarter,
  statusReportStarter,
  expenseReportStarter,
  // Marketing
  proposalStarter,
  pressReleaseStarter,
  // Finance
  quoteStarter,
  purchaseOrderStarter,
  // Operations
  sopStarter,
  checklistStarter,
  // Events
  eventInviteStarter,
  eventTicketStarter,
  // Education
  syllabusStarter,
];

// Shown separately in the dialog header as a "fresh start" option.
export const BLANK_STARTER: Starter = blankStarter;

export const STARTER_CATEGORIES: StarterCategory[] = [
  "Billing",
  "Legal",
  "HR",
  "Certificates",
  "Commerce",
  "Correspondence",
  "Reports",
  "Marketing",
  "Finance",
  "Operations",
  "Events",
  "Education",
];

export type { Starter, StarterCategory };
export { getStarterDoc } from "./to-doc";
export type { StarterDocResult } from "./to-doc";
