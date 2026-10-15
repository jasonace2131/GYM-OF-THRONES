import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/**
 * `POST /members/:id/change-email` — correcting a mistyped address on a member
 * who has never signed in. Trimmed and lower-cased, like every email this API stores.
 */
export class ChangeMemberEmailDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
