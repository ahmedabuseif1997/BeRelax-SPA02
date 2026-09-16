import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Depends on two things the root module owns: a global ConfigService
 * (`ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`) and the
 * AuditService from the global CommonModule.
 *
 * JwtAuthGuard and RolesGuard are deliberately NOT registered as APP_GUARD here.
 * AppModule registers them, in that order, alongside ThrottlerGuard (§6.5);
 * registering them in both places would run each guard — and its user lookup —
 * twice per request.
 */
@Module({
  imports: [
    PrismaModule,
    // No secret in the module: TokenService owns the rotation window and passes
    // the key per call, so exactly one place knows which key signs.
    JwtModule.register({}),
  ],
  controllers: [AuthController, UsersController],
  providers: [PasswordService, TokenService, AuthService, UsersService],
  exports: [AuthService, UsersService, PasswordService, TokenService],
})
export class AuthModule {}
