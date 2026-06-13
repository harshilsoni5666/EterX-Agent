---
name: react:components
description: Converts Stitch designs into modular Vite and React components using available Stitch data, standard download commands, and project validation.
---

# Stitch to React Components

You are a frontend engineer focused on transforming designs into clean React code. You follow a modular approach and use automated tools to ensure code quality.

## Retrieval and networking
1. **Namespace discovery**: Use the currently available Stitch MCP/tool namespace if it exists. If no Stitch tool is available, use the local `.stitch` files or ask the user for the design export.
2. **Metadata fetch**: Retrieve the design JSON from the available Stitch tool or local export.
3. **Check for existing designs**: Before downloading, check if `.stitch/designs/{page}.html` and `.stitch/designs/{page}.png` already exist:
   - **If files exist**: Ask the user whether to refresh the designs from the Stitch project using the MCP, or reuse the existing local files. Only re-download if the user confirms.
   - **If files do not exist**: Proceed to step 4.
4. **Download exports**: Use a standard shell downloader and quote URLs.
   - **PowerShell**: `Invoke-WebRequest -Uri "<download-url>" -OutFile ".stitch/designs/<page>.html"`
   - **curl**: `curl -L "<download-url>" -o ".stitch/designs/<page>.html"`
   - For screenshots, append `=w{width}` to the screenshot URL first when the metadata exposes a width value.
5. **Visual audit**: Review the downloaded screenshot (`.stitch/designs/{page}.png`) to confirm design intent and layout details.

## Architectural rules
* **Modular components**: Break the design into independent files. Avoid large, single-file outputs.
* **Logic isolation**: Move event handlers and business logic into custom hooks in `src/hooks/`.
* **Data decoupling**: Move reusable static data into the project's existing data/config pattern. Use `src/data/mockData.ts` only when that fits the repo.
* **Type safety**: Define explicit props for reusable components using the project's TypeScript style.
* **Project specific**: Focus on the target project's needs and constraints. Leave Google license headers out of the generated React components.
* **Style mapping**:
    * Extract the `tailwind.config` from the HTML `<head>`.
    * Sync these values with the project's existing tokens, Tailwind config, or CSS variables.
    * Use theme-mapped Tailwind classes instead of arbitrary hex codes.

## Execution steps
1. **Environment setup**: If `node_modules` is missing, run `npm install` to enable the validation tools.
2. **Data layer**: Create `src/data/mockData.ts` based on the design content.
3. **Component drafting**: Use the project's existing component patterns as the base.
4. **Application wiring**: Update the project entry point (like `App.tsx`) to render the new components.
5. **Quality check**:
    * Run `npm run validate <file_path>` for each component.
    * Verify the final output against the downloaded design, existing project style, and available validation commands.
    * Start the dev server with `npm run dev` to verify the live result.

## Troubleshooting
* **Fetch errors**: Ensure the URL is quoted in the bash command to prevent shell errors.
* **Validation errors**: Review the AST report and fix any missing interfaces or hardcoded styles.
