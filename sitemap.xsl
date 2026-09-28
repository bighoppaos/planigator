<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <title>Planigator sitemap</title>
        <style>
          body { font: 16px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; margin: 32px; color: #142033; }
          a { color: #0b6b4a; }
          li { margin: 8px 0; }
        </style>
      </head>
      <body>
        <h1>Planigator sitemap</h1>
        <p>These are the public pages. Search engines read this same file.</p>
        <ul>
          <xsl:for-each select="s:urlset/s:url">
            <li><a href="{s:loc}"><xsl:value-of select="s:loc"/></a></li>
          </xsl:for-each>
        </ul>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
