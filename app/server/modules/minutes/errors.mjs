import {AppError as DomainError} from '../../domain.mjs';
export class AppError extends DomainError {
  constructor(status,code,message){super(message,status);this.code=code;}
}
