# Build ReStar as a self-hostable monolith

ReStar will ship as one open-source application with PostgreSQL and a scheduled worker, deployable through Docker Compose and configurable with a standard email provider. We chose this over a Cloudflare-first or multi-service architecture so a solo developer can run it personally, retain ownership of the data, and maintain one operational boundary while validating the product.

The application may use hosted SMTP or Resend for deliverability, but no hosted platform is required for its core data or scheduling model.
