/**
 * Renders one or more schema.org JSON-LD documents into a script tag.
 * Server component: no client JS is shipped for structured data.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      // Controlled, serialised schema.org data; "<" is escaped above.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
