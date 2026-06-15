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

const termsDescription =
  "Terms and conditions for Rend Cloud, Rend APIs, hosted playback, SDKs, player, documentation, and related services.";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: termsDescription,
  alternates: {
    canonical: "/terms",
  },
  openGraph: {
    type: "website",
    url: "/terms",
    siteName,
    locale: siteLocale,
    title: "Terms and Conditions",
    description: termsDescription,
    images: [
      {
        url: "/opengraph-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "R Terms and Conditions",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Terms and Conditions",
    description: termsDescription,
    images: [
      {
        url: "/twitter-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "Terms and Conditions",
      },
    ],
  },
};

type TermsSection = {
  id: string;
  title: string;
  body: ReactNode;
};

const termsSections: TermsSection[] = [
  {
    id: "acceptance",
    title: "Acceptance of these Terms",
    body: (
      <>
        <p>
          These Terms and Conditions govern access to and use of Rend, including the
          Rend website, hosted dashboard, public APIs, video upload and playback
          services, edge delivery network, analytics, player, SDKs, documentation,
          and related services that link to these Terms. Rend is operated by Cap
          Software, Inc., a Delaware corporation. References to "Rend," "we,"
          "us," and "our" mean Cap Software, Inc. acting for the Rend service.
        </p>
        <p>
          By creating an account, clicking a button or checkbox that references
          these Terms, generating an API key, uploading video, using a Rend
          playback URL, subscribing to a plan, signing an order form, or otherwise
          accessing the Services, you agree to these Terms. If you do not agree,
          do not use the Services. If you use the Services for a company or other
          organization, you represent that you have authority to bind that
          organization, and "you" includes that organization.
        </p>
        <p>
          If you sign an order form, data processing agreement, service-level
          agreement, or other written agreement with us, that written agreement
          controls if it expressly conflicts with these Terms. Open-source license
          files control your rights to open-source components.
        </p>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Eligibility, Age, and Restricted Users",
    body: (
      <>
        <p>
          You must be at least 18 years old, or the age of legal majority where
          you live, to create an account or use the hosted Services. The Services
          are intended for developers and businesses and are not directed to
          children under 13. You may not create an account or use the Services if
          you are barred from doing so by applicable law.
        </p>
        <p>
          You represent that you and your end users are not located in, organized
          under the laws of, or ordinarily resident in a country, region, or
          territory subject to comprehensive sanctions or embargoes that prohibit
          the Services, and that you are not on any restricted-party list. You may
          not use Rend in violation of export controls, sanctions, embargoes,
          anti-bribery laws, or anti-corruption laws, or to provide services to
          prohibited end users.
        </p>
      </>
    ),
  },
  {
    id: "services",
    title: "The Rend Services",
    body: (
      <>
        <p>
          Rend Cloud is video-on-demand infrastructure for developers. The hosted
          Services let you upload source video by API or dashboard, encode and
          package playback artifacts, store Rend-managed asset files, deliver
          playback through Rend-controlled URLs and edge cache nodes, embed the Rend
          player, and view basic playback analytics.
        </p>
        <p>
          Rend may change, add, remove, suspend, or discontinue features, plans,
          edge regions, limits, APIs, SDK behavior, or documentation as the product
          evolves. Performance claims, launch targets, supported regions, 4K
          availability, or preview features are informational unless a separate
          written order, service-level agreement, or enterprise agreement says
          otherwise.
        </p>
        <p>
          For paid hosted plans, we will use reasonable efforts to avoid material
          reductions in core paid functionality during the applicable subscription
          term. We may still make changes needed for security, reliability, legal
          compliance, abuse prevention, provider changes, or normal product
          development.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts, API Keys, and Security",
    body: (
      <>
        <p>
          You are responsible for the accuracy of your account, workspace, billing,
          and payment information. You are also responsible for all activity under
          your account, including activity performed with API keys, bearer tokens,
          dashboard sessions, playback credentials, or other access credentials.
        </p>
        <p>
          Keep API keys and other credentials confidential, use them only as
          documented, and do not expose server-side keys in browser bundles, mobile
          apps, public repositories, videos, or support logs. You must promptly
          notify us if you believe your account or credentials have been
          compromised.
        </p>
        <p>
          You must maintain a current account owner, billing contact, and security
          contact where the dashboard supports them. We may require additional
          authentication, rotate credentials, or restrict access when we reasonably
          believe it is needed to protect your account, the Services, Rend, or
          third parties.
        </p>
      </>
    ),
  },
  {
    id: "customer-data",
    title: "Customer Data and Video Content",
    body: (
      <>
        <p>
          As between you and Rend, you retain ownership of videos, audio, images,
          captions, metadata, webhook payloads, analytics inputs, and other content
          or data that you or your end users submit to the Services ("Customer
          Data"). You are solely responsible for Customer Data and for obtaining all
          rights, licenses, notices, releases, and consents needed for Rend to
          receive and process it.
        </p>
        <p>
          You grant Rend a worldwide, non-exclusive, royalty-free license,
          sublicensable to our service providers and subprocessors only as needed,
          to host, copy, reproduce, encode, transcode, adapt for technical
          formatting, package, cache, route, transmit, distribute, publicly
          perform, publicly display, display, play, analyze, and otherwise process
          Customer Data as needed to provide, secure, monitor, troubleshoot,
          support, maintain, and bill for the Services. This license includes
          copying playback artifacts to Rend-owned or third-party infrastructure,
          warming opening bytes and segments to edge-local storage, generating
          thumbnails, previews, captions, manifests, renditions, and logs, and
          collecting playback request analytics such as request counts, bytes,
          status, region, device class, and cache state.
        </p>
        <p>
          The license above does not allow us to sell Customer Data,
          use Customer Data for third-party advertising, or train general-purpose
          AI models on Customer Data unless you separately agree. We may use
          aggregated or de-identified operational data to improve the Services, and
          we may inspect Customer Data when needed for security, abuse prevention,
          support, debugging, legal compliance, or your documented instructions.
        </p>
        <p>
          Do not use Rend to process protected health information, payment card
          data, classified information, special-category data, criminal-offense
          data, government identifiers, precise geolocation, biometric identifiers,
          sensitive personal information, data from children as defined by
          applicable law, or other highly regulated data unless we have signed a
          separate written agreement that expressly allows that use. You are also
          responsible for public-performance, public-display, distribution,
          synchronization, music, talent, privacy, and publicity rights needed for
          the way your videos are uploaded, stored, embedded, streamed, or shared.
        </p>
        <p>
          You are responsible for how you configure, protect, and share playback
          URLs, embeds, manifests, opener files, API responses, and derived media.
          If you make a playback URL public, leave it unprotected, embed it in a
          public application, or share it with third parties, you are responsible
          for the resulting access, viewing, copying, indexing, distribution, and
          legal consequences, even if the URL is difficult to guess or not linked
          from a public page.
        </p>
        <p>
          Rend is not obligated to monitor, pre-screen, review, or approve
          Customer Data before it is uploaded, encoded, stored, cached, or played
          back. We may perform automated or manual review when we believe it is
          appropriate for security, reliability, abuse prevention, legal
          compliance, support, or enforcement of these Terms, but we do not assume
          responsibility for Customer Data by doing so.
        </p>
      </>
    ),
  },
  {
    id: "open-source",
    title: "Open-Source and Self-Hosted Components",
    body: (
      <>
        <p>
          Some Rend software, including server components, the player, SDKs, tools,
          and examples, may be distributed as open source. Those components are
          governed by the license files and notices that accompany them. These Terms
          do not replace or limit rights you receive under those open-source
          licenses.
        </p>
        <p>
          If you self-host Rend or modify open-source Rend software, you are
          responsible for operating it, securing it, complying with applicable
          licenses, and managing your own infrastructure, storage, edge nodes,
          telemetry, billing, and end-user obligations. Hosted Rend Cloud support,
          uptime, billing, and deletion flows apply only to the hosted Services,
          unless we agree otherwise in writing.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable Use",
    body: (
      <>
        <p>You agree that you will not, and will not help others, use the Services to:</p>
        <ul>
          <li>violate any law, regulation, contract, intellectual property right, privacy right, publicity right, or other third-party right;</li>
          <li>upload, store, stream, share, or promote unlawful, infringing, exploitative, abusive, hateful, harassing, defamatory, obscene, fraudulent, deceptive, or otherwise harmful content;</li>
          <li>upload, store, stream, share, or promote child sexual abuse material, content that sexualizes minors, non-consensual intimate imagery, human trafficking content, terrorist content, violent extremist content, credible threats, instructions for physical harm, or content that facilitates violence, self-harm, exploitation, or abuse;</li>
          <li>harass, stalk, dox, intimidate, impersonate, defame, extort, blackmail, or otherwise target a person or group with abusive conduct;</li>
          <li>distribute malware, spyware, ransomware, botnets, exploit kits, credential-harvesting materials, phishing pages, spam, deceptive content, or code intended to interfere with systems or users;</li>
          <li>collect, process, disclose, or sell personal data in violation of law, without required consent, or in a way that enables surveillance, discrimination, identity theft, or unauthorized profiling;</li>
          <li>infringe, misappropriate, or enable unauthorized access to copyrighted works, trademarks, trade secrets, privacy rights, publicity rights, or other protected materials;</li>
          <li>evade law enforcement, sanctions, export controls, court orders, platform enforcement, network abuse controls, or legally valid takedown processes;</li>
          <li>circumvent service limits, rate limits, access controls, billing controls, playback authorization, suspension, deletion, or cache-purge mechanisms;</li>
          <li>probe, scan, load test, benchmark, scrape, reverse engineer, resell, sublicense, or create derivative services from Rend except as allowed by our documentation or open-source licenses;</li>
          <li>interfere with Rend infrastructure, edge nodes, origins, queues, dashboards, APIs, or other customers' use of the Services;</li>
          <li>use Rend as a permanent file locker, piracy distribution network, live-streaming platform, or general CDN unless that use is explicitly documented or agreed by us in writing; or</li>
          <li>misrepresent your relationship with Rend, Cap Software, or any other person or organization.</li>
        </ul>
        <p>
          You may conduct good-faith security testing of your own Rend account,
          assets, applications, and integrations if you stay within documented
          rate limits and plan limits, avoid degradation or access to other
          customers' data or systems, do not attempt persistence or data
          exfiltration, stop immediately if you encounter third-party data or
          service instability, and promptly report suspected vulnerabilities to{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>. Testing of Rend
          infrastructure, shared services, edge nodes, other customers' assets, or
          production abuse controls requires our prior written authorization.
        </p>
        <p>
          We may investigate suspected violations, remove or disable access to
          Customer Data, suspend assets or accounts, throttle traffic, revoke API
          keys, preserve evidence, and report activity to authorities when we
          reasonably believe it is necessary to protect Rend, users, third parties,
          or the Services.
        </p>
      </>
    ),
  },
  {
    id: "content-safety",
    title: "Content Safety and Abuse Reporting",
    body: (
      <>
        <p>
          Report suspected abuse, illegal content, security abuse, impersonation,
          phishing, malware, non-consensual intimate imagery, threats, harassment,
          or other violations involving the Services to{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>. Include the relevant
          Rend URL, asset identifier, account or workspace information if known, a
          description of the issue, and enough context for us to investigate. Do
          not misuse abuse reports to suppress lawful speech, lawful competition,
          or content you merely dislike.
        </p>
        <p>
          If you believe content involves child sexual abuse material, child
          exploitation, or other illegal sexual content involving minors, do not
          send, upload, attach, screenshot, download, forward, or redistribute the
          illegal material to us or anyone else. Send only the URL, asset
          identifier, account information if known, and a brief description. Where
          required under applicable law, we will preserve evidence, disable
          access, and report apparent child sexual abuse material to the National
          Center for Missing and Exploited Children or law enforcement. We may also
          preserve evidence, report threats or illegal activity to law enforcement,
          and cooperate with lawful requests, subpoenas, court orders, emergency
          disclosure requests, or mandatory reporting obligations where required or
          permitted by law.
        </p>
        <p>
          We have no duty to monitor or pre-screen Customer Data, but we may use
          automated tools, manual review, user reports, trusted reporter notices,
          provider notices, legal notices, and law enforcement referrals to detect,
          investigate, disable, remove, preserve, or report suspected abuse. We
          reserve the right to remove, disable, block, suspend, limit, or
          terminate access to content, accounts, assets, API keys, playback,
          cache, delivery, or other Services where we reasonably believe content
          or activity is abusive, illegal, unsafe, infringing, harmful, or
          otherwise violates these Terms, or where action is needed to protect
          users, minors, third parties, Rend, providers, or the Services.
        </p>
      </>
    ),
  },
  {
    id: "copyright",
    title: "Copyright and Takedown Requests",
    body: (
      <>
        <p>
          We may remove or disable access to Customer Data that we reasonably
          believe infringes intellectual property rights or violates these Terms.
          We maintain a repeat-infringer policy and may, in appropriate
          circumstances, suspend or terminate accounts, assets, workspaces, API
          keys, or playback access for users who repeatedly infringe, repeatedly
          receive credible infringement notices, submit abusive notices, or use the
          Services to enable infringement.
        </p>
        <p>
          Copyright notices should be sent to Rend's Copyright Agent at{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a> with the subject
          "Copyright Notice." We do not currently publish a postal address or
          phone number for copyright notices in these Terms. If you need those
          details for a statutory notice, contact us at the email above. When a
          Copyright Office DMCA designated-agent registration is completed, we will
          publish the registered agent details where required.
        </p>
        <p>
          If you believe material hosted or delivered by Rend infringes your
          copyright, send a written notice that includes: your physical or
          electronic signature; identification of the copyrighted work claimed to
          have been infringed, or a representative list if multiple works are
          covered by one notice; identification of the material claimed to be
          infringing and information reasonably sufficient for us to locate it,
          such as URLs, asset IDs, workspace information, or timestamps; your name,
          mailing address, telephone number if available, and email address; a
          statement that you have a good-faith belief that use of the material in
          the complained-of manner is not authorized by the copyright owner, its
          agent, or the law; and a statement, under penalty of perjury, that the
          information in the notice is accurate and that you are the copyright
          owner or authorized to act on the copyright owner's behalf.
        </p>
        <p>
          If your material was removed or disabled because of a copyright notice
          and you believe removal was mistaken or the material was
          misidentified, you may send a counter-notice to the Copyright Agent. A
          counter-notice must include: your physical or electronic signature;
          identification of the material that was removed or disabled and the
          location where it appeared before removal or disablement; a statement
          under penalty of perjury that you have a good-faith belief the material
          was removed or disabled as a result of mistake or misidentification;
          your name, mailing address, telephone number if available, and email
          address; a statement that you consent to the jurisdiction of the Federal
          District Court for the judicial district in which your address is
          located, or if your address is outside the United States, for any
          judicial district in which Rend may be found; and a statement that you
          will accept service of process from the person who submitted the
          copyright notice or that person's agent.
        </p>
        <p>
          We may forward copyright notices and counter-notices, including contact
          information, to affected users, complainants, hosting providers, legal
          advisers, or other parties as required or permitted by law. After we
          receive a valid counter-notice, we may restore the removed or disabled
          material in 10 to 14 business days unless the original complainant first
          notifies us that they filed an action seeking a court order to restrain
          the user from engaging in infringing activity relating to the material.
          We may reject incomplete, inaccurate, fraudulent, abusive, or legally
          insufficient notices or counter-notices.
        </p>
      </>
    ),
  },
  {
    id: "billing",
    title: "Plans, Billing, and Taxes",
    body: (
      <>
        <p>
          Hosted Rend may offer free, pay-as-you-go, subscription, usage-based,
          committed-use, or enterprise plans. Fees, credits, included usage,
          overages, and limits are described in the dashboard, pricing page, order
          form, invoice, or other written agreement that applies to your account.
          Unless stated otherwise, fees are non-refundable and exclusive of taxes.
        </p>
        <p>
          Rend billing may measure delivery, storage, or other usage by video
          duration, resolution tier, active asset duration, requests, bytes,
          regions, seats, or other units described for your plan. Encoding may be
          included or separately priced depending on the applicable plan or order.
          You authorize us and our payment processors to charge your payment method
          for all applicable fees, taxes, renewals, overages, and late amounts.
          If you believe an invoice or charge is wrong, you must notify us within
          30 days after the invoice or charge date so we can investigate; failure
          to do so may limit adjustments for that billing period, except where
          prohibited by law.
        </p>
        <p>
          Unless the checkout flow, dashboard, order form, or plan terms state
          otherwise, subscription plans continue until canceled and renew for the
          same billing period. Before charging a consumer payment method for an
          automatic renewal or continuous service, we will present the applicable
          renewal terms, pricing, billing frequency, cancellation method, and any
          required notices in the checkout or billing flow. You must cancel before
          the renewal date to avoid the next charge.
        </p>
        <p>
          You can cancel or manage a self-serve subscription through the billing
          portal where available, or by contacting{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a>. Cancellation takes
          effect at the end of the then-current billing period unless your plan,
          order form, or applicable law says otherwise. We do not provide prorated
          refunds or credits except where required by law, expressly stated in an
          applicable plan or order, or caused by a billing error that we verify.
          Usage fees, overages, and committed amounts already incurred remain due.
        </p>
        <p>
          If we offer a free trial, promotional price, or discounted period, the
          checkout or order will describe when the trial or discount ends, what
          price applies afterward, and how to cancel before charges begin or
          change. We will provide renewal, material-change, and fee-change notices
          when required by applicable law.
        </p>
        <p>
          You are responsible for taxes, duties, levies, withholding, and similar
          government assessments other than taxes based on our net income. If you do
          not pay amounts when due, we may suspend or limit uploads, API-key
          creation, playback, dashboard access, support, or other Services until
          your account is current.
        </p>
      </>
    ),
  },
  {
    id: "third-parties",
    title: "Third-Party Services",
    body: (
      <>
        <p>
          Rend may rely on third-party providers for services such as hosting,
          object storage, networking, DNS, email, authentication, observability,
          billing, payments, and customer support. We may process Customer Data and
          account information through those providers as needed to operate the
          Services.
        </p>
        <p>
          Third-party providers may be subprocessors where they process personal
          data on our behalf. You authorize us to use subprocessors for the
          provider categories above, provided we impose appropriate confidentiality
          and data protection obligations on them. Where required by applicable
          data protection law, we will provide notice of material subprocessor
          changes and a reasonable opportunity to object.
        </p>
        <p>
          If you connect Rend to your own applications, domains, storage, analytics,
          workflow tools, AI agents, or other third-party services, you are
          responsible for those integrations and for the instructions, data, and
          access you provide to them.
        </p>
      </>
    ),
  },
  {
    id: "privacy",
    title: "Privacy and Data Protection",
    body: (
      <>
        <p>
          We handle account information, billing information, usage information,
          support information, device and request data, player telemetry, asset
          metadata, and Customer Data in order to provide, secure, monitor,
          support, bill, troubleshoot, communicate about, comply with law, and
          improve Rend. This information may include names, email addresses,
          organization details, payment and billing identifiers, IP addresses,
          request logs, browser and device information, playback events, asset
          names, asset metadata, and video-related files you upload.
        </p>
        <p>
          Where data protection laws require a lawful basis for our own processing,
          we rely on performance of contract, legitimate interests in operating and
          securing the Services, compliance with legal obligations, consent where
          requested, and other bases permitted by law. We may disclose personal
          data to hosting, storage, networking, DNS, authentication, email,
          observability, billing, payment, analytics, support, professional
          adviser, and legal-compliance providers. Personal data may be processed
          in the United States and other jurisdictions where we or our providers
          operate, subject to legally required transfer safeguards where they apply.
        </p>
        <p>
          We retain account, billing, security, telemetry, support, and Customer
          Data for as long as needed to provide the Services, comply with legal and
          tax obligations, resolve disputes, enforce agreements, maintain security,
          prevent abuse, and support ordinary backup and archival processes. You
          may contact us at <a href="mailto:hello@rend.so">hello@rend.so</a> to
          request access, correction, deletion, export, objection, restriction, or
          other privacy rights available under applicable law.
        </p>
        <p>
          Where we process personal data on your behalf as a service provider or
          processor, these Terms are your documented instructions to process that
          data to provide, secure, monitor, support, troubleshoot, and bill for the
          Services as described here. We will use personnel and providers subject
          to confidentiality obligations, apply reasonable technical and
          organizational measures, notify you without undue delay after becoming
          aware of a security incident involving Customer Data, reasonably assist
          with data subject requests and compliance obligations that relate to our
          processing, and delete or return personal data at the end of the Services
          upon request unless law, security, backup, tax, accounting,
          abuse-prevention, or legal-preservation obligations require otherwise.
        </p>
        <p>
          You are responsible for providing legally sufficient privacy notices to
          your end users and for ensuring that your use of Rend complies with
          applicable data protection, cookie, consent, recording, surveillance,
          retention, and transfer laws. If applicable law or your customer requires
          a signed data processing addendum, contact us before uploading personal
          data that requires processor, service-provider, transfer, audit, or
          security terms beyond these Terms. These Terms are not intended to
          replace a signed data processing addendum, transfer addendum,
          subprocessor schedule, or security exhibit where your law, contract, or
          procurement requirements require those documents.
        </p>
      </>
    ),
  },
  {
    id: "confidentiality",
    title: "Confidentiality",
    body: (
      <>
        <p>
          Each party may receive non-public information from the other party that is
          marked confidential or should reasonably be understood as confidential
          given the circumstances. Your confidential information includes non-public
          Customer Data. Rend confidential information includes non-public product,
          roadmap, security, pricing, benchmark, infrastructure, and technical
          information.
        </p>
        <p>
          The receiving party will use confidential information only to perform or
          receive the Services, will protect it with reasonable care, and will share
          it only with personnel, contractors, professional advisers, and service
          providers who need access and are bound by confidentiality obligations.
          These duties do not apply to information that is public through no fault
          of the receiving party, already known without restriction, independently
          developed, or lawfully received from a third party.
        </p>
        <p>
          The receiving party may disclose confidential information when required
          by law, subpoena, or court order, but must give the disclosing party
          reasonable prior notice where legally permitted. Confidentiality duties
          survive for three years after disclosure, and trade secrets remain
          protected for as long as they qualify as trade secrets under law.
        </p>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Intellectual Property and Feedback",
    body: (
      <>
        <p>
          Rend and its licensors retain all rights in the hosted Services, website,
          dashboard, APIs, player experience, documentation, trademarks, logos,
          designs, and other Rend materials, except for rights expressly granted in
          these Terms or in applicable open-source licenses. You may not use Rend or
          Cap Software marks in a way that suggests sponsorship, endorsement, or
          affiliation without our written permission.
        </p>
        <p>
          If you send feedback, ideas, bug reports, feature requests, or suggestions
          about Rend, you grant us the right to use them without restriction,
          attribution, or compensation. During the term of your use of the
          Services, we may identify you or your organization by name as a Rend
          customer in customer lists and marketing materials unless you opt out by
          contacting us at <a href="mailto:hello@rend.so">hello@rend.so</a>. We
          will not use your logos, quotes, case studies, or endorsements without
          your permission.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and Termination",
    body: (
      <>
        <p>
          You may stop using Rend at any time. You may delete assets through the
          dashboard or API where supported, and you should export or copy Customer
          Data before closing your account or allowing a subscription to lapse.
        </p>
        <p>
          We may suspend or terminate access to all or part of the Services if you
          breach these Terms, fail to pay amounts when due, create risk for Rend or
          third parties, use excessive resources, violate applicable law, or if we
          discontinue the Services. Where practicable, we will give notice and a
          reasonable opportunity to cure before suspension or termination for
          non-payment or ordinary breach. We may act immediately for security,
          legal, abuse, infringement, sanctions, emergency, or operational risks.
        </p>
        <p>
          After suspension or termination, we may delete Customer Data associated
          with your account, subject to legal requirements, backup retention,
          abuse-prevention needs, and ordinary archival processes. Where legally
          permitted and technically available, we will use reasonable efforts to
          let you export Customer Data before permanent deletion from active
          systems. We are not responsible for retaining Customer Data after your
          account closes unless a separate written agreement says otherwise.
        </p>
        <p>
          Asset deletion and account termination may cause playback URLs, embeds,
          manifests, opener files, cached segments, analytics, API responses, and
          integrations to stop working. Some logs, telemetry, invoices, security
          records, support messages, and backups may be retained for legitimate
          business, legal, security, or compliance purposes.
        </p>
      </>
    ),
  },
  {
    id: "warranties",
    title: "Disclaimers",
    body: (
      <>
        <p>
          Except as expressly stated in a separate written agreement, the Services,
          open-source components, documentation, SDKs, player, APIs, analytics,
          benchmarks, and preview features are provided on an "as is" and "as
          available" basis. We disclaim all warranties, whether express, implied,
          statutory, or otherwise, including warranties of merchantability, fitness
          for a particular purpose, title, non-infringement, availability,
          reliability, security, accuracy, and error-free operation.
        </p>
        <p>
          Rend is video infrastructure, but your application, content, audience,
          network conditions, player configuration, viewer devices, third-party
          providers, and integration choices affect playback outcomes. We do not
          guarantee uninterrupted service, specific startup times, cache hit rates,
          analytics accuracy, revenue results, legal compliance, or compatibility
          with every source file, browser, device, network, or workflow.
        </p>
        <p>
          The Services are not designed for emergency, safety-critical,
          life-support, medical, financial trading, aviation, nuclear, or other
          high-risk uses where failure could lead to death, personal injury,
          severe property damage, or severe environmental damage. Nothing in these
          Terms limits warranties or rights that cannot be excluded under
          applicable law.
        </p>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limitation of Liability",
    body: (
      <>
        <p>
          To the fullest extent permitted by law, Rend, Cap Software, and their
          affiliates, officers, directors, employees, agents, suppliers, and
          licensors will not be liable for indirect, incidental, special,
          consequential, exemplary, punitive, or enhanced damages, or for lost
          profits, lost revenue, lost business, lost goodwill, loss of data, content
          corruption, replacement services, business interruption, or cost of cover,
          even if advised that such damages are possible.
        </p>
        <p>
          To the fullest extent permitted by law, our aggregate liability for all
          claims relating to the Services or these Terms will not exceed the greater
          of one hundred U.S. dollars or the amounts you paid to Rend for the
          Services giving rise to the claim during the three months before the event
          giving rise to liability.
        </p>
        <p>
          Nothing in these Terms excludes or limits liability that cannot be
          excluded or limited by law. The liability cap does not limit your payment
          obligations, your indemnification obligations, your responsibility for
          Customer Data, your misuse of credentials or the Services, either party's
          intentional infringement or misappropriation of the other party's
          intellectual property, either party's intentional breach of
          confidentiality, fraud, willful misconduct, or gross negligence, except to
          the extent those exclusions are not enforceable under applicable law.
        </p>
      </>
    ),
  },
  {
    id: "indemnification",
    title: "Indemnification",
    body: (
      <>
        <p>
          You will defend, indemnify, and hold harmless Rend, Cap Software, and
          their affiliates, officers, directors, employees, agents, suppliers, and
          licensors from and against claims, damages, liabilities, losses, costs,
          and expenses, including reasonable attorneys' fees, arising from or
          relating to Customer Data, your applications or integrations, your use of
          the Services, your violation of these Terms, your violation of law, or
          your infringement or misappropriation of third-party rights.
        </p>
        <p>
          We will give you prompt notice of an indemnified claim, allow you to
          control the defense where legally appropriate, and reasonably cooperate
          with you. You may not settle a claim in a way that admits fault by Rend,
          imposes obligations on Rend, or restricts Rend's business without our
          prior written consent.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <>
        <p>
          We may update these Terms from time to time by posting a revised version
          on this page or otherwise notifying you. The updated Terms become
          effective when posted unless the update says otherwise. If a change is
          material to active paid Services, automatic renewals, privacy rights, or
          your legal obligations, we will use reasonable efforts to provide at
          least 30 days' advance notice through the website, dashboard, email, or
          other account contact information before the change takes effect, unless
          the change is needed sooner for legal, security, or abuse-prevention
          reasons.
        </p>
        <p>
          Your continued use of the Services after updated Terms take effect means
          you accept the updated Terms. If you do not agree to an update, you must
          stop using the Services and cancel any applicable subscription. For
          prepaid paid Services, material adverse changes to core paid
          functionality will apply no earlier than the next renewal term unless
          required sooner for legal, security, provider, or abuse-prevention
          reasons.
        </p>
      </>
    ),
  },
  {
    id: "general",
    title: "General Terms",
    body: (
      <>
        <p>
          These Terms are governed by the laws of the State of Delaware, without
          regard to conflict-of-law rules. Any legal action or proceeding arising
          from these Terms or the Services will be brought exclusively in the state
          or federal courts located in Delaware, and each party consents to personal
          jurisdiction and venue in those courts, except where applicable law gives
          you mandatory rights to bring claims elsewhere.
        </p>
        <p>
          These Terms, together with any applicable order form, plan terms,
          documentation, data processing agreement, or other written agreement
          expressly incorporated by reference, are the entire agreement between you
          and us for the Services. If there is a conflict, the following order of
          precedence applies unless the later document expressly says otherwise:
          signed order form or enterprise agreement, data processing agreement,
          service-level agreement, plan-specific terms, these Terms, and then
          documentation.
        </p>
        <p>
          If any provision is unenforceable, the remaining provisions remain in
          effect. A party's failure to enforce a provision is not a waiver. Neither
          party is liable for delay or failure caused by events beyond its
          reasonable control. You may not assign these Terms without our prior
          written consent. We may assign these Terms as part of a merger,
          acquisition, financing, reorganization, sale of assets, or by operation
          of law.
        </p>
        <p>
          Provisions that by their nature should survive termination will survive,
          including provisions about payment, Customer Data, open-source licenses,
          acceptable use, copyright, confidentiality, intellectual property,
          disclaimers, liability limits, indemnification, governing law, venue,
          notices, and general terms.
        </p>
        <p>
          Notices to Rend should be sent to{" "}
          <a href="mailto:hello@rend.so">hello@rend.so</a> with the subject
          "Legal Notice" and to any postal address identified in an applicable
          order form, invoice, or dashboard notice. Copyright notices should follow
          the copyright section above. Notices to you may be sent to the email,
          billing, dashboard, or other contact information associated with your
          account.
        </p>
      </>
    ),
  },
];

function TermsNav() {
  return (
    <nav
      aria-label="Terms sections"
      className="sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto pr-3 lg:block"
    >
      <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
        Sections
      </p>
      <ol className="grid gap-1">
        {termsSections.map((section, index) => (
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

function TermsArticleSection({
  section,
  index,
}: {
  section: TermsSection;
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

export default function TermsPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-ink">
      <SiteHeader />

      <main>
        <Container size="wide" className="py-14 sm:py-18 md:py-20">
          <div className="max-w-[820px]">
            <h1 className="max-w-[760px] text-[clamp(38px,7vw,68px)] leading-[1.04]">
              Terms and Conditions
            </h1>
            <p className="mt-6 max-w-[720px] text-[clamp(17px,2vw,21px)] leading-[1.65] text-muted">
              These terms apply to hosted Rend Cloud, the Rend API, playback URLs,
              dashboard, player, SDKs, documentation, billing, content, and
              related services.
            </p>
            <p className="mt-5 font-mono text-sm text-faint">
              Last updated: June 15, 2026
            </p>
          </div>
        </Container>

        <Container size="wide" className="pb-20 md:pb-28">
          <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,820px)] lg:gap-14">
            <TermsNav />

            <article>
              {termsSections.map((section, index) => (
                <TermsArticleSection
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
