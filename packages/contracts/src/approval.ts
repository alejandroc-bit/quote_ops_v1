import { z } from "zod";

export const approvalStatusSchema = z.enum(["pending", "approved", "adjusted", "rejected"]);
export const approvalActionSchema = z.enum(["approve", "adjust", "reject"]);

export const approvalOptionSchema = z.discriminatedUnion("action", [
  z
  .object({
      action: z.literal("approve"),
      rate_mxn: z.number().finite().nonnegative()
    })
    .strict(),
  z
    .object({
      action: z.literal("adjust"),
      min_rate_mxn: z.number().finite().nonnegative(),
      max_rate_mxn: z.number().finite().nonnegative()
    })
    .strict(),
  z
    .object({
      action: z.literal("reject"),
    requires_reason: z.boolean().optional()
  })
    .strict()
]).superRefine((option, ctx) => {
  if (option.action === "adjust" && option.min_rate_mxn > option.max_rate_mxn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "min_rate_mxn must be less than or equal to max_rate_mxn",
      path: ["max_rate_mxn"]
    });
  }
});

export const approvalSchema = z
  .object({
    approval_id: z.string().regex(/^APR-\d{4}-\d{6}-L\d{2,}$/),
    status: approvalStatusSchema,
    required_role: z.string().min(1),
    reason_codes: z.array(z.string().min(1)),
    options: z.array(approvalOptionSchema).min(1),
    audit: z
      .object({
        base_quote_version: z.string().min(1),
        criteria_version: z.string().min(1),
        connector_version: z.string().min(1)
      })
      .strict()
  })
  .strict();

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type ApprovalOption = z.infer<typeof approvalOptionSchema>;
export type Approval = z.infer<typeof approvalSchema>;
