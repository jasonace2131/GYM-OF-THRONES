import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/** Every whitespace character goes: "123 456" pasted from an email is still the code. */
const withoutSpaces = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

/** Body of `POST /auth/login-code/verify`. Exactly six ASCII digits after spaces are dropped. */
export class VerifyLoginCodeDto {
  @Transform(withoutSpaces)
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
