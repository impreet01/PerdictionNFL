import js from "@eslint/js";

export default [
  {
    files: ["trainer/schemaValidator.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
      },
    },
    rules: js.configs.recommended.rules,
  },
];
