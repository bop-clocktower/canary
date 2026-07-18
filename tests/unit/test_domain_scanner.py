"""Unit tests for DomainScanner."""

import tempfile
import unittest
from pathlib import Path

from agent.core.domain_scanner import DomainScanner, DomainContext


class TestDomainContextIsEmpty(unittest.TestCase):

    def test_empty_by_default(self):
        self.assertTrue(DomainContext().is_empty)

    def test_not_empty_when_source_files_nonzero(self):
        self.assertFalse(DomainContext(source_files=1).is_empty)


class TestFindSourceFiles(unittest.TestCase):

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_python_files(self):
        (self.root / "service.py").write_text("class UserService: pass")
        ctx = self.scanner.scan(str(self.root))
        self.assertEqual(ctx.source_files, 1)

    def test_finds_ts_files(self):
        (self.root / "component.ts").write_text("export class Button {}")
        ctx = self.scanner.scan(str(self.root))
        self.assertEqual(ctx.source_files, 1)

    def test_skips_test_files_pytest_prefix(self):
        (self.root / "test_service.py").write_text("def test_foo(): pass")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_test_files_spec_suffix(self):
        (self.root / "login.spec.ts").write_text("test('x', () => {})")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_test_files_test_suffix(self):
        (self.root / "auth.test.ts").write_text("test('x', () => {})")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_node_modules(self):
        nm = self.root / "node_modules"
        nm.mkdir()
        (nm / "util.js").write_text("module.exports = {}")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_tests_directory(self):
        tests_dir = self.root / "tests"
        tests_dir.mkdir()
        (tests_dir / "helper.py").write_text("def helper(): pass")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_files_larger_than_max(self):
        big = self.root / "big.py"
        big.write_bytes(b"x" * (32_768 + 1))
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_empty_directory_returns_empty_context(self):
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)

    def test_skips_pycache(self):
        cache = self.root / "__pycache__"
        cache.mkdir()
        (cache / "util.py").write_text("x = 1")
        ctx = self.scanner.scan(str(self.root))
        self.assertTrue(ctx.is_empty)


class TestDeriveModules(unittest.TestCase):

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_module_path_derived_from_file(self):
        src = self.root / "src"
        src.mkdir()
        (src / "auth.py").write_text("class Auth: pass")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("src/auth", ctx.modules)

    def test_init_files_stripped(self):
        pkg = self.root / "myapp"
        pkg.mkdir()
        (pkg / "__init__.py").write_text("")
        (pkg / "service.py").write_text("class Svc: pass")
        ctx = self.scanner.scan(str(self.root))
        self.assertNotIn("myapp/__init__", ctx.modules)
        self.assertIn("myapp/service", ctx.modules)

    def test_ts_extension_stripped(self):
        (self.root / "Button.tsx").write_text("export function Button() {}")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("Button", ctx.modules)


class TestExtractPython(unittest.TestCase):

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name: str, content: str) -> None:
        (self.root / name).write_text(content)

    def test_extracts_classes(self):
        self._write("service.py", "class UserService:\n    pass\nclass AuthService:\n    pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("UserService", ctx.components)
        self.assertIn("AuthService", ctx.components)

    def test_extracts_public_functions(self):
        self._write("utils.py", "def create_user(name):\n    pass\ndef _internal():\n    pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("create_user", ctx.functions)
        self.assertNotIn("_internal", ctx.functions)

    def test_extracts_flask_routes(self):
        self._write("routes.py", "@app.get('/users')\ndef get_users(): pass\n@app.post('/users')\ndef create(): pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("GET /users", ctx.api_routes)
        self.assertIn("POST /users", ctx.api_routes)

    def test_extracts_fastapi_router_routes(self):
        self._write("api.py", "@router.get('/items/{id}')\nasync def get_item(id: int): pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("GET /items/{id}", ctx.api_routes)

    def test_extracts_blueprint_routes(self):
        self._write("bp.py", "@bp.post('/login')\ndef login(): pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("POST /login", ctx.api_routes)

    def test_skips_private_functions(self):
        self._write("utils.py", "def _helper(): pass\ndef __dunder(): pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertEqual(ctx.functions, [])

    def test_skips_unreadable_files(self):
        p = self.root / "service.py"
        p.write_text("class Good: pass")
        p2 = self.root / "bad.py"
        p2.write_text("class Bad: pass")
        p2.chmod(0o000)
        try:
            ctx = self.scanner.scan(str(self.root))
            self.assertIn("Good", ctx.components)
        finally:
            p2.chmod(0o644)


class TestExtractJavaScript(unittest.TestCase):

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name: str, content: str) -> None:
        (self.root / name).write_text(content)

    def test_extracts_export_class(self):
        self._write("auth.ts", "export class AuthService {}\nexport class TokenService {}\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("AuthService", ctx.components)
        self.assertIn("TokenService", ctx.components)

    def test_extracts_export_default_class(self):
        self._write("app.ts", "export default class App {}\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("App", ctx.components)

    def test_extracts_pascal_case_export_function_as_component(self):
        self._write("Button.tsx", "export function Button() { return <div/>; }\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("Button", ctx.components)
        self.assertNotIn("Button", ctx.functions)

    def test_extracts_camel_case_export_function_as_function(self):
        self._write("utils.ts", "export function fetchUser(id: string) {}\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("fetchUser", ctx.functions)
        self.assertNotIn("fetchUser", ctx.components)

    def test_extracts_export_const_pascal_as_component(self):
        self._write("Card.tsx", "export const Card = () => <div/>;\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("Card", ctx.components)

    def test_extracts_export_const_camel_as_function(self):
        self._write("helpers.ts", "export const formatDate = (d: Date) => d.toISOString();\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("formatDate", ctx.functions)

    def test_extracts_export_const_with_dotted_type_annotation(self):
        self._write("Login.tsx", "export const Login: React.FC<Props> = () => <form/>;\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("Login", ctx.components)

    def test_extracts_export_const_with_zod_type_annotation(self):
        self._write("schema.ts", "export const userSchema: z.ZodObject<UserShape> = z.object({});\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("userSchema", ctx.functions)

    def test_extracts_express_routes(self):
        self._write("routes.ts", "router.get('/users', handler);\nrouter.post('/users', create);\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("GET /users", ctx.api_routes)
        self.assertIn("POST /users", ctx.api_routes)

    def test_extracts_async_export_function(self):
        self._write("api.ts", "export async function loadData() {}\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("loadData", ctx.functions)


class TestDeduplication(unittest.TestCase):

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_deduplicates_components_across_files(self):
        (self.root / "a.py").write_text("class UserService: pass\n")
        (self.root / "b.py").write_text("class UserService: pass\n")
        ctx = self.scanner.scan(str(self.root))
        self.assertEqual(ctx.components.count("UserService"), 1)

    def test_caps_components_at_max(self):
        lines = "\n".join(f"class Component{i}: pass" for i in range(20))
        (self.root / "big.py").write_text(lines)
        ctx = self.scanner.scan(str(self.root))
        self.assertLessEqual(len(ctx.components), 15)


class TestUnreadableFilesSkipped(unittest.TestCase):
    """Fix #4 (issue #299): a source path that matches the glob but can't be
    read as text (e.g. a directory named `foo.py`) must be skipped silently
    rather than crashing the scan. Covers the OSError branch in scan()."""

    def setUp(self):
        self.scanner = DomainScanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_directory_named_like_source_file_is_skipped(self):
        # A directory whose name ends in .py is matched by the **/*.py glob;
        # read_text() on it raises IsADirectoryError (an OSError subclass).
        (self.root / "package.py").mkdir()
        (self.root / "real.py").write_text("class RealService: pass\n")
        # Must not raise, and the real file's symbols still come through.
        ctx = self.scanner.scan(str(self.root))
        self.assertIn("RealService", ctx.components)

    def test_scan_returns_context_when_all_files_unreadable(self):
        (self.root / "only.py").mkdir()
        ctx = self.scanner.scan(str(self.root))
        self.assertIsInstance(ctx, DomainContext)
        self.assertEqual(ctx.components, [])
