/** Thrown when an actor's role is insufficient for the requested authority.
 *  (Token-scope rejections surface as ScopeError from the scope.ts helpers.)
 *  mutate()'s spineErrorStatus maps both to HTTP 403. */
export class AuthorityError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
    this.name = "AuthorityError";
  }
}

