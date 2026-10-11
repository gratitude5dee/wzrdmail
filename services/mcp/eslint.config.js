import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["src/ui/app-html.generated.ts"]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
