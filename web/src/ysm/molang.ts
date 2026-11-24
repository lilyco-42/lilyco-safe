/**
 * Safe Zero-Eval Bedrock Molang Expression Evaluator
 * Supports arithmetic, ternary, parentheses, q./query. variables, and degree-based math.* functions.
 */

export interface MolangContext {
  animTime: number;
  lifeTime: number;
  groundSpeed: number;
  headXRot: number;
  headYRot: number;
}

const DEG2RAD = Math.PI / 180;

type TokenType = 'num' | 'id' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.trim();
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < s.length && /[0-9.eE]/.test(s[i])) {
        num += s[i++];
      }
      tokens.push({ type: 'num', value: num });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < s.length && /[a-zA-Z0-9_.]/.test(s[i])) {
        id += s[i++];
      }
      tokens.push({ type: 'id', value: id.toLowerCase() });
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i++;
      continue;
    }
    if ('+-*/%?:><=!&|'.includes(ch)) {
      let op = ch;
      if (i + 1 < s.length && '=<>|&'.includes(s[i + 1])) {
        op += s[i + 1];
        i++;
      }
      tokens.push({ type: 'op', value: op });
      i++;
      continue;
    }
    i++;
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class MolangParser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly ctx: MolangContext,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] || { type: 'eof', value: '' };
  }

  private consume(): Token {
    return this.tokens[this.pos++] || { type: 'eof', value: '' };
  }

  parse(): number {
    const val = this.parseTernary();
    return Number.isFinite(val) ? val : 0;
  }

  private parseTernary(): number {
    const cond = this.parseCompare();
    if (this.peek().type === 'op' && this.peek().value === '?') {
      this.consume();
      const tVal = this.parseTernary();
      if (this.peek().type === 'op' && this.peek().value === ':') {
        this.consume();
      }
      const fVal = this.parseTernary();
      return cond !== 0 ? tVal : fVal;
    }
    return cond;
  }

  private parseCompare(): number {
    let left = this.parseAddSub();
    while (
      this.peek().type === 'op' &&
      ['>', '<', '>=', '<=', '==', '!='].includes(this.peek().value)
    ) {
      const op = this.consume().value;
      const right = this.parseAddSub();
      if (op === '>') left = left > right ? 1 : 0;
      else if (op === '<') left = left < right ? 1 : 0;
      else if (op === '>=') left = left >= right ? 1 : 0;
      else if (op === '<=') left = left <= right ? 1 : 0;
      else if (op === '==') left = Math.abs(left - right) < 1e-6 ? 1 : 0;
      else if (op === '!=') left = Math.abs(left - right) >= 1e-6 ? 1 : 0;
    }
    return left;
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const right = this.parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (
      this.peek().type === 'op' &&
      (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')
    ) {
      const op = this.consume().value;
      const right = this.parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') left = Math.abs(right) < 1e-9 ? 0 : left / right;
      else left = Math.abs(right) < 1e-9 ? 0 : left % right;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.consume();
      return -this.parseUnary();
    }
    if (this.peek().type === 'op' && this.peek().value === '+') {
      this.consume();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.peek();
    if (tok.type === 'num') {
      this.consume();
      return parseFloat(tok.value) || 0;
    }
    if (tok.type === 'lparen') {
      this.consume();
      const val = this.parseTernary();
      if (this.peek().type === 'rparen') this.consume();
      return val;
    }
    if (tok.type === 'id') {
      this.consume();
      if (this.peek().type === 'lparen') {
        this.consume();
        const args: number[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseTernary());
          while (this.peek().type === 'comma') {
            this.consume();
            args.push(this.parseTernary());
          }
        }
        if (this.peek().type === 'rparen') this.consume();
        return this.evalFunc(tok.value, args);
      }
      return this.evalVar(tok.value);
    }
    return 0;
  }

  private evalVar(name: string): number {
    if (name === 'q.anim_time' || name === 'query.anim_time') return this.ctx.animTime;
    if (name === 'q.life_time' || name === 'query.life_time') return this.ctx.lifeTime;
    if (name === 'q.ground_speed' || name === 'query.ground_speed') return this.ctx.groundSpeed;
    if (name === 'q.modified_move_speed' || name === 'query.modified_move_speed') return this.ctx.groundSpeed;
    if (name === 'q.head_x_rotation' || name === 'query.head_x_rotation') return this.ctx.headXRot;
    if (name === 'q.head_y_rotation' || name === 'query.head_y_rotation') return this.ctx.headYRot;
    if (name === 'math.pi') return Math.PI;
    return 0;
  }

  private evalFunc(name: string, a: number[]): number {
    const x = a[0] ?? 0;
    const y = a[1] ?? 0;
    const z = a[2] ?? 0;
    switch (name) {
      case 'math.sin':
        return Math.sin(x * DEG2RAD);
      case 'math.cos':
        return Math.cos(x * DEG2RAD);
      case 'math.abs':
        return Math.abs(x);
      case 'math.clamp':
        return Math.max(y, Math.min(z, x));
      case 'math.lerp':
        return x + (y - x) * z;
      case 'math.min':
        return Math.min(x, y);
      case 'math.max':
        return Math.max(x, y);
      case 'math.floor':
        return Math.floor(x);
      case 'math.ceil':
        return Math.ceil(x);
      case 'math.round':
        return Math.round(x);
      case 'math.sqrt':
        return x >= 0 ? Math.sqrt(x) : 0;
      case 'math.pow':
        return Math.pow(x, y);
      case 'math.mod':
        return Math.abs(y) < 1e-9 ? 0 : x % y;
      default:
        return 0;
    }
  }
}

const tokenCache = new Map<string, Token[]>();

export function evalMolang(val: number | string | undefined, ctx: MolangContext): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const trimmed = val.trim();
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum)) return asNum;

  let tokens = tokenCache.get(trimmed);
  if (!tokens) {
    tokens = tokenize(trimmed);
    if (tokenCache.size > 512) tokenCache.clear();
    tokenCache.set(trimmed, tokens);
  }
  return new MolangParser(tokens, ctx).parse();
}
