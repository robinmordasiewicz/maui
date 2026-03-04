#!/bin/bash
# update-gh-session.sh — Push current ik-session.json to GitHub Actions secret
#
# Run this after ik-auth.mjs to sync the session to GitHub.
# Requires: gh CLI authenticated to the repo.
#
# Usage: ./scripts/update-gh-session.sh

set -e

SESSION_FILE="$(dirname "$0")/../output/cache/ik-session.json"
REPO="robinmordasiewicz/maui"

if [ ! -f "$SESSION_FILE" ]; then
  echo "ERROR: No session file found at $SESSION_FILE"
  echo "Run: node scripts/ik-auth.mjs"
  exit 1
fi

echo "Encoding session..."
SESSION_B64=$(base64 -i "$SESSION_FILE")
echo "Session size: $(echo "$SESSION_B64" | wc -c) chars"

echo "Pushing IK_SESSION secret to $REPO..."
gh secret set IK_SESSION --body "$SESSION_B64" --repo "$REPO"

echo "Done. GitHub Actions will use this session on next run."
echo ""
echo "Session info:"
node -e "
const d = JSON.parse(require('fs').readFileSync('$SESSION_FILE'));
const c = d.cookies?.find(c => c.name === 'wfToken');
const exp = c?.expires ? new Date(c.expires * 1000).toISOString() : 'unknown';
const age = Math.round((Date.now() - new Date(d.saved_at)) / (1000*3600*24));
console.log('  Saved:', d.saved_at, '(' + age + ' days ago)');
console.log('  Expires:', exp);
console.log('  Token:', d.wf_token?.substring(0,8) + '...');
"
