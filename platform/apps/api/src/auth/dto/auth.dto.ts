import { changePasswordSchema, loginSchema } from '@berelax/contracts';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

export type { ChangePasswordDto, LoginDto } from '@berelax/contracts';

// The schemas live in @berelax/contracts so the dashboard validates against the
// same rules; these are just the pipes that apply them at the edge. Pipes hold
// no request state, so one instance per schema is enough.
export const loginBodyPipe = new ZodValidationPipe(loginSchema);
export const changePasswordBodyPipe = new ZodValidationPipe(changePasswordSchema);
