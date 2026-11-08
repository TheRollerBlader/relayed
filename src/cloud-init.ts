import { escapeHtml } from "./domain.js";

/**
 * Cloud-init user data for a new Ubuntu server.
 * Vultr expects this string to be base64-encoded in `user_data`.
 * It only runs on first boot, so an existing server is never reinstalled.
 */
export function placeholderUserData(domain: string): string {
  const safeDomain = escapeHtml(domain);
  const cloudConfig = `#cloud-config
package_update: true
packages:
  - nginx
write_files:
  - path: /var/www/html/index.html
    permissions: "0644"
    content: |
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${safeDomain}</title>
      </head>
      <body>
        <h1>${safeDomain}</h1>
        <p>This site is hosted on Vultr.</p>
      </body>
      </html>
runcmd:
  - systemctl enable nginx
  - systemctl restart nginx
`;
  return Buffer.from(cloudConfig, "utf8").toString("base64");
}
