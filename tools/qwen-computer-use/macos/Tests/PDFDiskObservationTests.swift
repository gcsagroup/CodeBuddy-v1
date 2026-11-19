import XCTest
import PDFKit
@testable import qwen_computer_runtime

final class PDFDiskObservationTests: XCTestCase {
    private func temporaryURL() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: dir) }
        return dir.appendingPathComponent("客户 草稿.pdf")
    }

    private func document(_ pairs: [(String, String)]) -> PDFDocument {
        let document = PDFDocument(), page = PDFPage()
        page.setBounds(CGRect(x: 0, y: 0, width: 400, height: 500), for: .mediaBox)
        document.insert(page, at: 0)
        for (index, pair) in pairs.enumerated() {
            let field = PDFAnnotation(bounds: CGRect(x: 10, y: 20 + index * 40, width: 300, height: 30), forType: .widget, withProperties: nil)
            field.widgetFieldType = .text; field.fieldName = pair.0; field.widgetStringValue = pair.1
            page.addAnnotation(field)
        }
        return document
    }

    func testDiskValuesRemainDistinctFromUnsavedUIAndRefreshAfterSaving() throws {
        let url = try temporaryURL()
        let original = document([("公司", "旧公司"), ("邮箱", ""), ("邮箱", "billing-keep@example.test"), ("备注", "原备注\n第二行")])
        XCTAssertTrue(original.write(to: url))
        let before = try Data(contentsOf: url)
        original.page(at: 0)!.annotations[0].widgetStringValue = "海风测试"
        let receipt = try XCTUnwrap(PDFDiskObservation.read(documentURL: url.absoluteString))
        XCTAssertEqual(receipt["status"] as? String, "read")
        let rows = try XCTUnwrap(receipt["fields"] as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["value"] as? String }, ["旧公司", "", "billing-keep@example.test", "原备注\n第二行"])
        XCTAssertEqual(rows.filter { $0["name"] as? String == "邮箱" }.count, 2)
        XCTAssertEqual(try Data(contentsOf: url), before, "Observation must never save the in-memory edit")
        XCTAssertTrue(original.write(to: url))
        let saved = try XCTUnwrap(PDFDiskObservation.read(documentURL: url.absoluteString))
        XCTAssertEqual((saved["fields"] as? [[String: Any]])?.first?["value"] as? String, "海风测试")
    }

    func testNonlocalPathsAreNotReadAndUnavailableFilesNeverReportSuccess() throws {
        for invalid in ["", "/tmp/a.pdf", "https://example.test/a.pdf", "file://otherhost/share/a.pdf", "file:///tmp/a.txt"] {
            XCTAssertNil(PDFDiskObservation.read(documentURL: invalid))
        }
        let url = try temporaryURL()
        XCTAssertEqual(PDFDiskObservation.read(documentURL: url.absoluteString)?["status"] as? String, "unavailable")
        try Data("not a PDF".utf8).write(to: url)
        let invalid = try XCTUnwrap(PDFDiskObservation.read(documentURL: url.absoluteString))
        XCTAssertEqual(invalid["status"] as? String, "unavailable")
        XCTAssertNil(invalid["fields"])
    }

    func testOversizedFieldPayloadDoesNotProduceTruncatedSuccess() throws {
        let url = try temporaryURL()
        XCTAssertTrue(document([("备注", String(repeating: "中文原值", count: 4000))]).write(to: url))
        let result = try XCTUnwrap(PDFDiskObservation.read(documentURL: url.absoluteString))
        XCTAssertEqual(result["status"] as? String, "unavailable")
        XCTAssertNil(result["fields"])
    }
}
