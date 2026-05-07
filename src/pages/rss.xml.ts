import { getAllAnalyses } from '../lib/data';

const SITE = 'https://market.bnpc.in';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<Response> {
  const analyses = (await getAllAnalyses()).slice(0, 30);

  const items = analyses.map((a) => `
  <item>
    <title>${escapeXml(`${a.date}: ${a.overall_bias} — ${a.headline_call}`)}</title>
    <description>${escapeXml(a.summary)}</description>
    <pubDate>${new Date(a.date).toUTCString()}</pubDate>
    <link>${SITE}/archive/${a.date}/</link>
    <guid isPermaLink="true">${SITE}/archive/${a.date}/</guid>
  </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>BNPC Daily Market Outlook</title>
    <description>Daily AI-powered Indian stock market morning analysis by BNPC Private Limited.</description>
    <link>${SITE}</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
    <language>en-IN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
