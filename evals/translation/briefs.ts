/** Briefs for the base documents of the translation golden set: 12 per domain. */
export type Domain = "contract" | "policy" | "marketing";

export interface Brief {
  id: string;
  domain: Domain;
  brief: string;
}

const contract = [
  "Mutual non-disclosure agreement between a robotics startup and a manufacturing partner",
  "Software development services agreement with milestone payments",
  "Commercial office lease for a 3-year term with rent escalation",
  "Employment offer letter for a senior data engineer with salary, bonus and start date",
  "SaaS subscription order form with seat count, annual fee and renewal terms",
  "Purchase order for industrial pumps with quantities, unit prices and delivery date",
  "Short-term business loan agreement with interest rate and repayment schedule",
  "Software license agreement with territory restrictions and royalty percentage",
  "Freelance consulting agreement with hourly rate, cap and invoicing terms",
  "Exclusive distribution agreement for organic cosmetics in one country",
  "Equipment rental agreement with deposit, daily rate and damage terms",
  "Supply agreement for coffee beans with price per kilogram and minimum volumes",
];
const policy = [
  "Privacy policy section on data retention periods and user rights",
  "Refund and cancellation policy for an online course platform",
  "Terms of service section on account suspension and termination",
  "Shipping policy with delivery times, costs and thresholds for free shipping",
  "Data processing addendum section on sub-processors and breach notification deadlines",
  "Product warranty terms with coverage period and exclusions",
  "Subscription billing terms with trial period, price changes and notice periods",
  "Returns policy for an electronics retailer with restocking fees",
  "Acceptable use policy for a cloud hosting provider with rate limits",
  "Cookie policy describing cookie categories and retention",
  "Loyalty program terms with points earning rates and expiry",
  "Event ticket terms with transfer, refund and age restrictions",
];
const marketing = [
  "Product launch email for a smart thermostat with launch-day discount",
  "Landing page copy for a project management tool with pricing tiers",
  "Press release announcing a fintech company's Series A funding",
  "Hotel listing description with room features, check-in times and rates",
  "Newsletter for a bike shop announcing a seasonal sale and workshop dates",
  "App store description for a language-learning app with subscription prices",
  "Event invitation for a B2B industry conference with venue and dates",
  "Case study summary of a logistics company reducing delivery times",
  "Promotional offer terms for a meal-kit service's first-box discount",
  "Online course description with module count, duration and price",
  "Real estate listing for a city apartment with size, price and features",
  "Nonprofit fundraising update with amounts raised and program results",
];

export const BRIEFS: Brief[] = [
  ...contract.map((brief, i) => ({
    id: `c${String(i + 1).padStart(2, "0")}`,
    domain: "contract" as const,
    brief,
  })),
  ...policy.map((brief, i) => ({
    id: `p${String(i + 1).padStart(2, "0")}`,
    domain: "policy" as const,
    brief,
  })),
  ...marketing.map((brief, i) => ({
    id: `m${String(i + 1).padStart(2, "0")}`,
    domain: "marketing" as const,
    brief,
  })),
];
