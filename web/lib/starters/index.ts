import { invoiceStarter } from "./invoice";
import { receiptStarter } from "./receipt";
import { ndaStarter } from "./nda";
import { offerLetterStarter } from "./offer-letter";
import { employmentContractStarter } from "./employment-contract";
import { jobDescriptionStarter } from "./job-description";
import { promotionLetterStarter } from "./promotion-letter";
import { terminationLetterStarter } from "./termination-letter";
import { recommendationLetterStarter } from "./recommendation-letter";
import { warningLetterStarter } from "./warning-letter";
import { onboardingChecklistStarter } from "./onboarding-checklist";
import { salarySlipStarter } from "./salary-slip";
import { appointmentLetterStarter } from "./appointment-letter";
import { pipStarter } from "./pip";
import { experienceCertificateStarter } from "./experience-certificate";
import { leaveApplicationStarter } from "./leave-application";
import { certificateStarter } from "./certificate";
import { certificateAchievementStarter } from "./certificate-achievement";
import { certificateParticipationStarter } from "./certificate-participation";
import { certificateAppreciationStarter } from "./certificate-appreciation";
import { certificateExcellenceStarter } from "./certificate-excellence";
import { certificateTrainingStarter } from "./certificate-training";
import { certificateInternshipStarter } from "./certificate-internship";
import { certificateAwardStarter } from "./certificate-award";
import { certificateEmployeeMonthStarter } from "./certificate-employee-month";
import { certificateVolunteerStarter } from "./certificate-volunteer";
import { certificateWorkshopStarter } from "./certificate-workshop";
import { letterStarter } from "./letter";
import { resumeStarter } from "./resume";
import { resumeClassicStarter } from "./resume-classic";
import { resumeTwoColumnStarter } from "./resume-two-column";
import { resumeCreativeStarter } from "./resume-creative";
import { resumeExecutiveStarter } from "./resume-executive";
import { resumeTechStarter } from "./resume-tech";
import { resumeAcademicStarter } from "./resume-academic";
import { resumeFunctionalStarter } from "./resume-functional";
import { resumeInfographicStarter } from "./resume-infographic";
import { resumeFederalStarter } from "./resume-federal";
import { resumeEuropeanStarter } from "./resume-european";
import { resumeOnepageStarter } from "./resume-onepage";
import { resumeWithCoverStarter } from "./resume-with-cover";
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
import { thermalBillStarter } from "./thermal-bill";
import { eBillStarter } from "./e-bill";
import { mobileBillStarter } from "./mobile-bill";
import { manualBillStarter } from "./manual-bill";
import { posBillStarter } from "./pos-bill";
import { cloudBillStarter } from "./cloud-bill";
import { subscriptionBillStarter } from "./subscription-bill";
import { gstInvoiceStarter } from "./gst-invoice";
import type { Starter, StarterCategory } from "./types";

export const STARTERS: Starter[] = [
  // Billing
  invoiceStarter,
  receiptStarter,
  statementStarter,
  thermalBillStarter,
  eBillStarter,
  mobileBillStarter,
  manualBillStarter,
  posBillStarter,
  cloudBillStarter,
  subscriptionBillStarter,
  gstInvoiceStarter,
  // Legal
  ndaStarter,
  leaseAgreementStarter,
  // HR
  offerLetterStarter,
  appointmentLetterStarter,
  employmentContractStarter,
  jobDescriptionStarter,
  onboardingChecklistStarter,
  promotionLetterStarter,
  performanceReviewStarter,
  pipStarter,
  warningLetterStarter,
  recommendationLetterStarter,
  leaveApplicationStarter,
  salarySlipStarter,
  experienceCertificateStarter,
  terminationLetterStarter,
  // Resume
  resumeStarter,
  resumeClassicStarter,
  resumeTwoColumnStarter,
  resumeCreativeStarter,
  resumeExecutiveStarter,
  resumeTechStarter,
  resumeAcademicStarter,
  resumeFunctionalStarter,
  resumeInfographicStarter,
  resumeFederalStarter,
  resumeEuropeanStarter,
  resumeOnepageStarter,
  resumeWithCoverStarter,
  // Certificates
  certificateStarter,
  certificateAchievementStarter,
  certificateExcellenceStarter,
  certificateAwardStarter,
  certificateAppreciationStarter,
  certificateEmployeeMonthStarter,
  certificateParticipationStarter,
  certificateWorkshopStarter,
  certificateTrainingStarter,
  certificateInternshipStarter,
  certificateVolunteerStarter,
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
  "Resume",
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
