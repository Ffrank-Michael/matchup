import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The 21st.dev Web3 Bento component is kept exactly as published (3 strict
    // react-hooks style errors). Remove this line once it is turned into Kairo tiles.
    "components/ui/web3-bento.tsx",
  ]),
]);

export default eslintConfig;
