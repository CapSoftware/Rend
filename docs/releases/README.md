# Accepted Release Manifests

This directory is the non-secret archive for accepted release manifests.
`scripts/release-images.sh --push` copies the manifest here by default so
operators can retrieve the exact image digests, git SHA, and platform metadata
after `.rend/releases/` scratch files are gone.

Only commit manifests for accepted production releases. Do not put
env files, registry credentials, host credentials, or deployment secrets here.
