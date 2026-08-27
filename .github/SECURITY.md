# Security policy

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/Siunami/attend/security/advisories/new). Include the affected Attend version, reproduction steps, expected impact, and any known workaround. Remove private source data, credentials, local capability URLs, and absolute file paths before submitting the report.

## Supported versions

The latest npm release receives security fixes. Upgrade with:

```sh
npm install --global @siunami/attend@latest
attend bootstrap --yes
```

Attend deprecates an affected older version when users must stop installing it.

## Security boundary

Attend reads only the source paths supplied to a command. It stores project state below the gitignored `.attend/` directory, binds its viewer to loopback, and has no Attend-hosted account or telemetry. A host coding agent may still send bounded source content through that agent's configured provider route.
