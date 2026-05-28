# Contributing

Thanks for considering a contribution.

## Who Can Make Changes

Anyone can open an issue or submit a pull request. Direct changes to the main
branch are limited to the repository owner or maintainers. Pull requests should
be reviewed before merge.

## Before Opening an Issue

- Check whether the issue is already reported.
- Include your operating system, Python version, Node.js version, and browser.
- Never include `credentials.json`, `token.json`, `rules.yml`, email content,
  OAuth tokens, or screenshots containing private email data.

## Before Opening a Pull Request

- Keep changes focused on one problem or feature.
- Use generic examples only.
- Do not commit personal Gmail rules, OAuth credentials, tokens, generated
  history, local virtual environments, build output, or editor metadata.
- Update `README.md` when setup, behavior, or UI navigation changes.
- Run the frontend build before submitting:

  ```powershell
  cd web
  npm run build
  ```

- Run a Python syntax check:

  ```powershell
  uv run --system-certs python -m py_compile app_api.py gmail_cleanup.py
  ```

## Security and Privacy

This project works with Gmail metadata and mailbox actions. Treat all local
configuration and screenshots as sensitive. If you find a security issue, do
not open a public issue with private details. Contact the repository owner
privately first.
