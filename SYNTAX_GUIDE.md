# JSON Architect - Prompt Syntax Guide

## Quick Reference

### 1. Accessing Entire Source
```
@Source 1                    → Returns entire JSON from Source 1
@SOURCE_1                    → Same (uppercase works too)
@source 1                    → Same (lowercase works too)
@filename.txt                → Reference by file name directly
@doc5.txt                    → Works with any file name
```

### 2. Accessing Nested Paths
```
@Source 1 user.name          → Gets user.name from Source 1
@Source 1 users[0]           → Gets first item in users array
@Source 1 users[0].profile   → Gets profile of first user
@doc.txt data.items[2].id    → Deep nested access (file name)
```

### 3. Flexible Path Access (Auto-finds nested paths)
```
@Source 1 level_7            → Finds level_7 anywhere in hierarchy
                               (e.g., project.level_1.level_2...level_7)
@Source 1 chain_3            → Finds chain_3 in nested structure
@Source 1 stage_3.maps       → Finds stage_3 then gets .maps from it
```

### 4. Creating Objects (Compose)
```
{
  "key1": @Source 1
  "key2": @Source 2 user.name
  "key3": @Source 3 items[0]
}
```
**Output:** `{ "key1": {...}, "key2": "value", "key3": {...} }`

### 5. Creating Arrays of Objects
```
array of objects with "main1": @Source 1, "main2": @Source 2, "main3": @Source 3
```
**Output:** `[{"main1": {...}}, {"main2": {...}}, {"main3": {...}}]`

### 6. Single-line Compose (Comma-separated)
```
"name": @Source 1 user.name, "email": @Source 1 user.email, "orders": @Source 2
```
**Output:** `{ "name": "...", "email": "...", "orders": [...] }`

### 7. Injection Syntax (Inject INTO a base source)
```
"demo": @doc5.txt, @doc5.txt[menu]: @doc3.txt, @doc4.txt[you]: @mohandemo.txt
```
**Output:**
```json
{
  "demo": {
    ...doc5.txt content...,
    "menu": { ...doc3.txt content (INJECTED)... }
  }
}
```

**How it works:**
- `"demo": @doc5.txt` → Establishes doc5.txt as the base for "demo"
- `@doc5.txt[menu]: @doc3.txt` → Injects doc3.txt INTO doc5.txt at path "menu"
- `@doc4.txt[you]: @mohandemo.txt` → **IGNORED** because doc4.txt is not used as a base

**Rule:** Only sources that are assigned to a key (like `"demo": @doc5.txt`) can receive injections.

### 8. Simple Bracket Keys (Independent objects)
```
[key1]: @Source 1, [key2]: @Source 2
```
**Output:** `{ "key1": {...}, "key2": {...} }`

---

## Path Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `.` | `user.name` | Access object property |
| `[n]` | `items[0]` | Access array index (0-based) |
| `[*]` | `users[*].name` | Get property from all array items |
| Flexible | `level_7` | Auto-finds key in nested structure |

---

## Output Formats

### Object Output (Default)
```
{
  "a": @Source 1
  "b": @Source 2
}
```
Result: `{"a": {...}, "b": {...}}`

### Array Output
Use keywords: `array of objects`, `list of objects`, `create []`
```
array of objects with "a": @Source 1, "b": @Source 2
```
Result: `[{"a": {...}}, {"b": {...}}]`

---

## Examples

### Example 1: Extract Specific Fields
**Sources:**
- Source 1: `{"user": {"name": "John", "age": 30, "email": "john@example.com"}}`

**Prompt:**
```
{
  "userName": @Source 1 user.name
  "userAge": @Source 1 user.age
}
```

**Result:**
```json
{
  "userName": "John",
  "userAge": 30
}
```

### Example 2: Combine Multiple Sources
**Sources:**
- Source 1: `{"company": "Acme Inc"}`
- Source 2: `{"employees": [{"name": "Alice"}, {"name": "Bob"}]}`

**Prompt:**
```
{
  "companyInfo": @Source 1
  "staff": @Source 2 employees
}
```

**Result:**
```json
{
  "companyInfo": {"company": "Acme Inc"},
  "staff": [{"name": "Alice"}, {"name": "Bob"}]
}
```

### Example 3: Create Array of Objects
**Prompt:**
```
array of objects with "task": @Source 1, "game": @Source 2, "hospital": @Source 3
```

**Result:**
```json
[
  {"task": {...Source 1 data...}},
  {"game": {...Source 2 data...}},
  {"hospital": {...Source 3 data...}}
]
```

### Example 4: Deep Nested Access with Flexible Paths
**Source 1:** Deeply nested with `project.level_1.level_2.level_3.level_7`

**Prompt:**
```
{
  "deepData": @Source 1 level_7
}
```
System auto-finds `level_7` regardless of nesting depth.

---

## Tips

1. **Quotes around keys** - Use `"key"` or `'key'` in compose prompts
2. **Flexible paths** - Just use the final key name; system finds it automatically
3. **Array keyword** - Say "array of objects" to get `[{}, {}]` format
4. **Whitespace** - Spaces around `:` and `,` are optional
5. **Source naming** - `Source 1`, `SOURCE_1`, `source 1` all work the same

---

## Array Operations (Advanced)

### Filtering Arrays
```
@Source 1 users[status=active]              → Filter where status equals "active"
@Source 1 items[price>100]                  → Filter where price > 100
@Source 1 orders[quantity>=5]               → Filter where quantity >= 5
@Source 1 users[role!=admin]                → Filter where role is not "admin"
```

Or use the `filter()` function:
```
@Source 1 users.filter(status=active)
@Source 1 products.filter(price<50)
```

### Sorting Arrays
```
@Source 1 users.sort(asc:name)              → Sort ascending by name
@Source 1 orders.sort(desc:date)            → Sort descending by date
@Source 1 items.sort(asc:price)             → Sort ascending by price
```

### Array Slicing
```
@Source 1 items.slice(0,5)                  → First 5 items
@Source 1 items.slice(10)                   → Items from index 10 onwards
@Source 1 items.slice(-3)                   → Last 3 items
```

### First/Last Elements
```
@Source 1 items.first                       → First item (single object)
@Source 1 items.first(3)                    → First 3 items (array)
@Source 1 items.last                        → Last item (single object)
@Source 1 items.last(5)                     → Last 5 items (array)
```

### Count/Length
```
@Source 1 users.count                       → Number of items (returns integer)
@Source 1 items.length                      → Same as count
```

### Other Operations
```
@Source 1 items.reverse                     → Reverse array order
@Source 1 items.unique                      → Remove duplicates
@Source 1 nested.flatten                    → Flatten nested arrays
```

### Chaining Operations
```
@Source 1 users.filter(active=true).sort(asc:name).first(10)
```
Filter active users → Sort by name → Take first 10

### Map/Extract from All Items
```
@Source 1 users[*].name                     → Extract 'name' from all users
@Source 1 orders[*].total                   → Extract 'total' from all orders
```

---

## Complex Examples

### Example: Filter + Sort + Limit
**Source 1:** `{"products": [{"name": "A", "price": 100}, {"name": "B", "price": 50}, ...]}`

**Prompt:**
```
{
  "cheapProducts": @Source 1 products.filter(price<100).sort(asc:price).first(5)
}
```

### Example: Dynamic Composition with Array Operations
**Prompt:**
```
"activeUsers": @Source 1 users[status=active].sort(desc:lastLogin),
"totalOrders": @Source 2 orders.count,
"recentItems": @Source 3 items.sort(desc:createdAt).first(10)
```

### Example: Injection with Path Operations
**Prompt:**
```
"dashboard": @Source 1, @Source 1[topUsers]: @Source 2 users.filter(premium=true).first(5)
```
Injects filtered premium users into Source 1 at "topUsers" path.
