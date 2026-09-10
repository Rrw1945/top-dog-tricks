---
name: Orval, Zod, and form resolver compatibility
description: Compatibility constraints between generated API schemas, Zod, and React Hook Form validation.
---

The generated API validation package must use the same Zod major version expected by the installed Orval generator; newer Orval releases can emit Zod 4-only helpers such as `z.int()` and `z.url()`.

**Why:** A successful codegen run can still fail the workspace typecheck when the catalog pins an older Zod major version.

**How to apply:** When API codegen starts producing missing Zod helper errors, inspect the generator output and align the workspace catalog version before debugging application routes.

The Zod major version must also match the form resolver in browser code. The installed React Hook Form resolver 3.x expects Zod 3's `error.errors`; it does not safely handle Zod 4's `error.issues`.

**Why:** An invalid submission could surface as an unhandled browser rejection instead of field-level messages, making a valid video appear to have failed.

**How to apply:** When the workspace uses Zod 4, use a resolver release with Zod 4 support or a small adapter that maps `error.issues` into React Hook Form field errors.

When adding a sibling OpenAPI path beneath an existing path, verify that every HTTP operation remains indented under its intended path before trusting generated client names.

**Why:** Valid YAML and a successful Orval run can still attach an existing operation to the wrong URL, producing a type-safe client that sends requests to a 404 route.

**How to apply:** After adding nested-looking routes such as `/resources/{id}/analyze`, inspect the surrounding OpenAPI block and grep the generated URL builder for both the original update route and the new route.