import { z } from "zod";

const versionSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const digestImageSchema = z
  .string()
  .regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/, "digest-pinned image required")
  .refine(
    (value) => !/:latest@sha256:/i.test(value),
    "latest is forbidden even when digest-pinned"
  );
const applicationImageSchema = digestImageSchema.refine(
  (value) => /:v\d+\.\d+\.\d+@sha256:/.test(value),
  "application image requires semver tag plus digest"
);

export const applianceReleaseSchema = z
  .object({
    schema_version: z.literal(1),
    version: versionSchema,
    git_sha: z.string().regex(/^[a-f0-9]{40}$/),
    platform: z.literal("linux/amd64"),
    images: z
      .object({
        agent: applicationImageSchema,
        api: applicationImageSchema,
        web: applicationImageSchema,
        postgres: digestImageSchema,
        redis: digestImageSchema,
        caddy: digestImageSchema,
        cloudflared: digestImageSchema
      })
      .strict(),
    files_sha256: z.record(z.string().min(1), sha256Schema),
    created_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((release, context) => {
    for (const image of ["agent", "api", "web"] as const) {
      if (!release.images[image].includes(`:${release.version}@sha256:`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", image],
          message: `application image tag must equal ${release.version}`
        });
      }
    }
  });

export type ApplianceRelease = z.infer<typeof applianceReleaseSchema>;

export function parseApplianceRelease(value: unknown): ApplianceRelease {
  return applianceReleaseSchema.parse(value);
}

export const publishedApplianceReleaseSchema = z
  .object({
    manifest: applianceReleaseSchema,
    bundle_sha256: sha256Schema
  })
  .strict();

export type PublishedApplianceRelease = z.infer<
  typeof publishedApplianceReleaseSchema
>;

export function parsePublishedApplianceRelease(
  value: unknown
): PublishedApplianceRelease {
  return publishedApplianceReleaseSchema.parse(value);
}
