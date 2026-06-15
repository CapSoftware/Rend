import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Container } from "@/components/ui/Container";
import {
  ogImageSize,
  siteLocale,
  siteName,
} from "@/lib/seo";

const privacyDescription =
  "Privacy notice for Rend site visitors, account users, customer admins, viewers, end users, and support contacts.";

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: privacyDescription,
  alternates: {
    canonical: "/privacy",
  },
  openGraph: {
    type: "website",
    url: "/privacy",
    siteName,
    locale: siteLocale,
    title: "Privacy Notice",
    description: privacyDescription,
    images: [
      {
        url: "/opengraph-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "Rend Privacy Notice",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Notice",
    description: privacyDescription,
    images: [
      {
        url: "/twitter-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "Privacy Notice",
      },
    ],
  },
};

type PrivacySection = {
  id: string;
  title: string;
  body: ReactNode;
};

const privacySections: PrivacySection[] = [
  {
    id: "overview",
    title: "Overview",
    body: (
      <>
        <p>
          This Privacy Notice explains how Rend handles personal data for the Rend
          website, hosted dashboard, public APIs, video upload and playback
          services, edge delivery network, analytics, player, SDKs, documentation,
          and related services that link to this notice. Rend is operated by Cap
          Software, Inc., a Delaware corporation. References to "Rend," "we,"
          "us," and "our" mean Cap Software, Inc. acting for the Rend service.
        </p>
        <p>
          This notice applies to site visitors, account users, customer admins,
          billing and security contacts, people who contact support or sales, and
          viewers or other end users who interact with videos, embeds, player
          experiences, or playback URLs powered by Rend.
        </p>
        <p>
          Rend provides infrastructure to customers. In many cases, the customer
          decides what video, metadata, viewer data, and other personal data is
          submitted to Rend. In those cases, the customer is responsible for its
          own privacy notices and choices, and Rend processes the data to provide
          the service.
        </p>
      </>
    ),
  },
  {
    id: "data-categories",
    title: "Personal Data We Process",
    body: (
      <>
        <p>
          The personal data we process depends on how you interact with Rend and
          how a customer configures its use of the service. It may include:
        </p>
        <ul>
          <li>contact details, such as name, email address, company, role, and communication preferences;</li>
          <li>account details, such as workspace, user, admin, authentication, authorization, dashboard, API key, and session information;</li>
          <li>billing details, such as plan, invoice, subscription, tax, payment status, and payment processor identifiers;</li>
          <li>customer content and metadata, such as uploaded video, audio, captions, thumbnails, asset names, file details, manifests, playback artifacts, webhook payloads, and integration metadata;</li>
          <li>viewer and end-user data, such as IP address, request URL, playback URL, embed page context, browser, device, network, approximate region, timestamps, playback events, request counts, bytes, status codes, cache state, and diagnostic logs;</li>
          <li>support and communications data, such as emails, messages, tickets, feedback, bug reports, call notes, attachments, and related context you provide; and</li>
          <li>security and operational data, such as audit events, abuse signals, rate-limit events, error logs, performance telemetry, and records needed to protect Rend and its users.</li>
        </ul>
        <p>
          Please do not submit protected health information, payment card data,
          classified information, biometric identifiers, data from children under
          13, or other highly regulated data unless we have signed a separate
          written agreement that expressly allows that use.
        </p>
      </>
    ),
  },
  {
    id: "sources",
    title: "Sources",
    body: (
      <>
        <p>
          We collect personal data directly from you when you visit the website,
          create an account, use the dashboard or APIs, upload content, configure
          playback, subscribe to a plan, contact us, or send support information.
        </p>
        <p>
          We also receive personal data from customers and their applications,
          from viewers and end users who request or play Rend-powered videos, from
          service providers that help us operate Rend, and from systems that
          automatically generate logs, telemetry, analytics, security events, and
          billing records.
        </p>
      </>
    ),
  },
  {
    id: "purposes",
    title: "Purposes and Lawful Bases",
    body: (
      <>
        <p>
          We use personal data to provide, maintain, secure, monitor, support, and
          improve Rend. This includes account management, authentication, video
          upload, encoding, packaging, storage, edge delivery, playback, analytics,
          dashboard features, API operation, customer support, billing,
          troubleshooting, abuse prevention, legal compliance, product planning,
          and service communications.
        </p>
        <p>
          Where data protection laws require a lawful basis, we rely on
          performance of contract to provide Rend to customers and account users,
          legitimate interests in operating, securing, improving, and explaining
          our service, compliance with legal obligations, consent where we ask for
          it, and other lawful bases available under applicable law.
        </p>
        <p>
          We do not sell customer content, use Customer Data for third-party
          advertising, or train general-purpose AI models on Customer Data unless
          the customer separately agrees. We may use aggregated or de-identified
          operational data for reporting, product analysis, security, performance
          measurement, and business planning.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and Similar Technologies",
    body: (
      <>
        <p>
          Rend may use cookies, local storage, session tokens, pixels, SDK
          telemetry, logs, and similar technologies to keep you signed in, operate
          the dashboard, remember settings, measure site and product usage,
          diagnose performance, prevent abuse, and understand whether Rend is
          working as expected.
        </p>
        <p>
          Customers that embed Rend-powered players or use Rend APIs are
          responsible for providing any cookie, tracking, consent, or device
          access notices required for their own websites, applications, and end
          users.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Recipients and Disclosure",
    body: (
      <>
        <p>
          We disclose personal data only as needed for the purposes described in
          this notice, as directed by a customer, or as required or permitted by
          law. Recipient categories may include hosting, storage, networking, DNS,
          authentication, email, observability, analytics, billing, payment,
          customer support, security, professional adviser, and legal-compliance
          providers.
        </p>
        <p>
          We may disclose personal data to customers and customer admins where the
          data relates to their workspace, users, assets, playback, logs,
          analytics, billing, support, or end-user activity. We may also disclose
          information in connection with a merger, acquisition, financing,
          reorganization, sale of assets, legal request, emergency, suspected
          abuse, rights enforcement, or protection of Rend, users, viewers, or
          third parties.
        </p>
        <p>
          We may use aggregated or de-identified information for reporting,
          product analysis, security, performance measurement, and business
          planning.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International Transfers",
    body: (
      <>
        <p>
          Rend and its service providers may process personal data in the United
          States and other jurisdictions where we or our providers operate. Those
          jurisdictions may have data protection laws that differ from the laws
          where you live.
        </p>
        <p>
          Where transfer safeguards are required by applicable law, we use
          appropriate measures such as contractual protections, data processing
          terms, the European Commission Standard Contractual Clauses, the UK
          international data transfer addendum or agreement, or other legally
          recognized transfer mechanisms as applicable.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "Retention",
    body: (
      <>
        <p>
          We retain personal data for as long as needed to provide Rend, maintain
          accounts, deliver playback, support customers, bill for services, comply
          with legal and tax obligations, resolve disputes, enforce agreements,
          maintain security, prevent abuse, and support ordinary backup and
          archival processes.
        </p>
        <p>
          Retention periods vary by data type. Customer content and playback
          artifacts may be retained while an account or asset remains active.
          Account, billing, tax, security, support, telemetry, and log records may
          be retained longer where needed for legitimate business, legal,
          compliance, security, or audit purposes. Backups and cached copies may
          persist for a limited period after deletion from active systems.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your Privacy Rights",
    body: (
      <>
        <p>
          Depending on where you live, you may have rights to request access,
          correction, deletion, portability, restriction, objection, withdrawal of
          consent, or review of certain automated decisions. You may also have the
          right to complain to a data protection authority.
        </p>
        <p>
          To make a request, contact us at{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>. We may ask for
          information needed to verify your identity, locate the relevant account
          or data, understand the request, and confirm whether Rend is acting as
          controller, processor, service provider, or contractor for the data at
          issue.
        </p>
        <p>
          If your request relates to data controlled by a Rend customer, we may
          direct you to that customer or assist the customer with the request as
          required by applicable law and our agreement with the customer.
        </p>
      </>
    ),
  },
  {
    id: "ccpa",
    title: "CCPA Style Rights",
    body: (
      <>
        <p>
          If you are in California or another U.S. state with similar privacy
          rights, you may have the right to know or access categories and specific
          pieces of personal information, correct inaccurate personal information,
          delete personal information, obtain a portable copy, opt out of certain
          sales or sharing, limit certain uses of sensitive personal information,
          and be free from discrimination for exercising privacy rights.
        </p>
        <p>
          Based on our current practices, Rend does not sell personal information
          and does not share personal information for cross-context behavioral
          advertising, including personal information about website visitors,
          account users, customer admins, viewers, end users, support contacts,
          Customer Data, logs, telemetry, or cookies. We also do not use sensitive
          personal information for purposes that require a right to limit use
          under California law. If our practices change in a way that requires an
          opt-out mechanism, Global Privacy Control handling, or another consumer
          choice, we will provide it as required by law.
        </p>
        <p>
          You or an authorized agent may submit a privacy request by emailing{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>. We may need to verify
          the request and the agent's authority before acting on it.
        </p>
      </>
    ),
  },
  {
    id: "controller-processor",
    title: "Controller and Processor Roles",
    body: (
      <>
        <p>
          Rend acts as a controller for personal data we process for our own
          business purposes, such as website operation, account administration,
          customer communications, billing, security, legal compliance, and service
          improvement.
        </p>
        <p>
          Rend acts as a processor, service provider, or contractor when we process
          personal data in customer content, customer applications, playback
          activity, viewer events, logs, or related operational data on behalf of a
          customer and under the customer's instructions.
        </p>
        <p>
          Customers are responsible for determining whether they may submit
          personal data to Rend, providing notices and obtaining consents where
          required, responding to end-user requests, and ensuring their use of Rend
          complies with applicable privacy, cookie, recording, surveillance,
          retention, and transfer laws.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <>
        <p>
          We use technical and organizational measures designed to protect
          personal data against unauthorized access, loss, misuse, alteration, and
          disclosure. These measures vary based on the nature of the data and the
          risks involved.
        </p>
        <p>
          No online service can guarantee perfect security. You are responsible
          for protecting account credentials, API keys, playback credentials,
          integration secrets, and access to the systems you connect to Rend.
          Please contact us promptly if you believe your account or data has been
          compromised.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <>
        <p>
          Rend is intended for developers and businesses. It is not directed to
          children under 13, and we do not knowingly collect personal data from
          children under 13 through our website or account services.
        </p>
        <p>
          Customers may not use Rend for child-directed services or to process data
          from children as defined by applicable law unless we have signed a
          separate written agreement that expressly allows that use and the
          customer has all required rights, age-gating, parental consent, school or
          educational terms, notices, and deletion procedures.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to This Notice",
    body: (
      <>
        <p>
          We may update this Privacy Notice from time to time by posting a revised
          version on this page or otherwise notifying you. The updated notice
          becomes effective when posted unless it says otherwise.
        </p>
        <p>
          If a change is material to active paid services, privacy rights, or how
          we process personal data, we will use reasonable efforts to provide
          advance notice through the website, dashboard, email, or other account
          contact information before the change takes effect, unless the change is
          needed sooner for legal, security, or abuse-prevention reasons.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <>
        <p>
          You can contact Rend about this Privacy Notice or privacy requests at{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>.
        </p>
        <p>
          Please include enough context for us to understand your request, such as
          the relevant account, workspace, asset, playback URL, support thread, or
          customer relationship. Do not send sensitive personal data unless it is
          needed for the request.
        </p>
      </>
    ),
  },
];

function PrivacyNav() {
  return (
    <nav
      aria-label="Privacy sections"
      className="sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto pr-3 lg:block"
    >
      <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
        Sections
      </p>
      <ol className="grid gap-1">
        {privacySections.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="block rounded-md px-2 py-2 text-sm leading-snug text-muted transition-colors hover:bg-bg-sunken hover:text-ink focus-visible:bg-bg-sunken focus-visible:text-ink focus-visible:outline-none"
            >
              <span className="mr-2 font-mono text-[11px] text-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              {section.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function PrivacyArticleSection({
  section,
  index,
}: {
  section: PrivacySection;
  index: number;
}) {
  return (
    <section
      id={section.id}
      className="scroll-mt-24 border-t border-line py-9 first:border-t-0 first:pt-0"
    >
      <p className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
        {String(index + 1).padStart(2, "0")}
      </p>
      <h2 className="mb-5 text-[clamp(26px,4vw,38px)] leading-tight">
        {section.title}
      </h2>
      <div className="terms-prose grid gap-4 text-[16px] leading-[1.75] text-ink-soft">
        {section.body}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-ink">
      <SiteHeader />

      <main>
        <Container size="wide" className="py-14 sm:py-18 md:py-20">
          <div className="max-w-[820px]">
            <h1 className="max-w-[760px] text-[clamp(38px,7vw,68px)] leading-[1.04]">
              Privacy Notice
            </h1>
            <p className="mt-6 max-w-[720px] text-[clamp(17px,2vw,21px)] leading-[1.65] text-muted">
              This notice explains how Rend handles personal data for visitors,
              account users, customer admins, viewers, end users, and people who
              contact us for support.
            </p>
            <p className="mt-5 font-mono text-sm text-faint">
              Last updated: June 15, 2026
            </p>
          </div>
        </Container>

        <Container size="wide" className="pb-20 md:pb-28">
          <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,820px)] lg:gap-14">
            <PrivacyNav />

            <article>
              {privacySections.map((section, index) => (
                <PrivacyArticleSection
                  key={section.id}
                  section={section}
                  index={index}
                />
              ))}

              <div className="mt-12 border-t border-line pt-8">
                <Link
                  href="/"
                  className="text-sm font-semibold text-ink underline decoration-line decoration-2 underline-offset-4 transition hover:decoration-accent"
                >
                  Back to Rend
                </Link>
              </div>
            </article>
          </div>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
