import { z } from 'zod';
import { passwordProblem } from '../utils/password.js';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required').max(200),
  rememberMe: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
  newPassword: z.string().superRefine((pw, ctx) => {
    const problem = passwordProblem(pw);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
});
