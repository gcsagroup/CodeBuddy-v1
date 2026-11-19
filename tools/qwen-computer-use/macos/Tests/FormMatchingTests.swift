import XCTest
@testable import qwen_computer_runtime

final class FormMatchingTests: XCTestCase {
    @MainActor
    func testChineseProjectionProducesRealRecommendationsAndLeavesOtherFieldsUnscored() async throws {
        let bounds = WindowFrame(CGRect(x: 0, y: 0, width: 600, height: 400))
        let fields = [
            NativeElement(index:7,runtimeId:[0,1],automationId:"company",name:"公司",controlType:"AXTextField",value:"",frame:nil,actions:[]),
            NativeElement(index:11,runtimeId:[0,2],automationId:"work",name:"工作邮箱",controlType:"AXTextField",value:"",frame:nil,actions:[]),
            NativeElement(index:15,runtimeId:[0,3],automationId:"billing",name:"账单邮箱",controlType:"AXTextField",value:"billing-keep@example.test",frame:nil,actions:[]),
            NativeElement(index:18,runtimeId:[0,4],automationId:"notes",name:"备注",controlType:"AXTextArea",value:"旧备注逐字保留 731",frame:nil,actions:[])]
        let entities = [NativeFormEntity(label:"公司",value:"海风测试"),NativeFormEntity(label:"工作邮箱",value:"qa@example.test")]
        let labels = NativeFormLabels(title:"Customer Form",fields:[NativeFormFieldLabel(element:fields[0],label:"Company"),NativeFormFieldLabel(element:fields[1],label:"Email")],entities:["Company","Email"],observedElements:fields,observedTitle:"客户表单",observedBounds:bounds)
        let result = try await NativeFormMatching.match(title:"客户表单",elements:fields,entities:entities,labels:labels,bounds:bounds)
        let rows = try XCTUnwrap(result["recommendations"] as? [[String:Any]])
        XCTAssertEqual(rows.count,4)
        for i in 0..<2 {
            XCTAssertEqual(rows[i]["recommended_action"] as? String,"fill")
            XCTAssertEqual(rows[i]["recommended_value"] as? String,entities[i].value)
            XCTAssertEqual(rows[i]["original_label"] as? String,fields[i].name)
            XCTAssertEqual(rows[i]["current_value"] as? String,"")
            XCTAssertEqual(rows[i]["execution"] as? String,"local-coreml")
            XCTAssertNotNil(rows[i]["probabilities"])
        }
        for i in 2..<4 {
            XCTAssertEqual(rows[i]["recommended_action"] as? String,"skip")
            XCTAssertEqual(rows[i]["execution"] as? String,"not_run")
            XCTAssertEqual(rows[i]["current_value"] as? String,fields[i].value)
            XCTAssertNil(rows[i]["probabilities"])
        }
        let ambiguous = NativeFormLabels(title:"Customer Form",fields:[],entities:["Company","Email"],observedElements:fields,observedTitle:"客户表单",observedBounds:bounds)
        let noTargets = try await NativeFormMatching.match(title:"客户表单",elements:fields,entities:entities,labels:ambiguous,bounds:bounds)
        XCTAssertEqual(noTargets["execution"] as? String,"not_run")
        XCTAssertEqual(noTargets["status"] as? String,"no_mapped_fields")
        print("Chinese projection real CoreML: \(result)")
    }

    @MainActor
    func testMissingControlsNeverClaimModelScoring() async throws {
        let result = try await NativeFormMatching.match(title: "Unavailable AX tree", elements: [],
            entities: [NativeFormEntity(label: "Company", value: "Northwind Works")])
        XCTAssertEqual(result["status"] as? String, "no_fields")
        XCTAssertEqual(result["execution"] as? String, "not_run")
        XCTAssertEqual((result["recommendations"] as? [[String: Any]])?.count, 0)
    }

    @MainActor
    func testBlankEnglishFieldHasARealFillRecommendation() async throws {
        let base = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        guard FileManager.default.fileExists(atPath: base.appendingPathComponent("FluidAudio/Models/cua-s1-forms/cua_s1_forms_fp16_options32.mlmodelc").path) else {
            throw XCTSkip("Prepare the local FORMS model explicitly before this integration test.")
        }
        let field = NativeElement(index: 4, runtimeId: [0, 1], automationId: "name", name: "Full name",
                                  controlType: "AXTextField", value: "", frame: nil, actions: [])
        let result = try await NativeFormMatching.match(title: "Job Application", elements: [field],
            entities: [NativeFormEntity(label: "Name", value: "Maya Okafor"), NativeFormEntity(label: "Email", value: "maya@example.test")])
        let row = try XCTUnwrap((result["recommendations"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["recommended_action"] as? String, "fill")
        XCTAssertEqual(row["entity_index"] as? Int, 0)
        XCTAssertEqual(row["recommended_value"] as? String, "Maya Okafor")
        XCTAssertEqual(row["element_index"] as? String, "4")
        XCTAssertEqual(field.value, "", "Scoring must leave the input untouched")
    }

    @MainActor
    func testUnnamedPDFFieldUsesObservedNearbyTextWithoutChangingItsIdentity() async throws {
        let base = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        guard FileManager.default.fileExists(atPath: base.appendingPathComponent("FluidAudio/Models/cua-s1-forms/cua_s1_forms_fp16_options32.mlmodelc").path) else {
            throw XCTSkip("Prepare the local FORMS model explicitly before this integration test.")
        }
        let label = NativeElement(index: 3, runtimeId: [0, 0], automationId: "", name: "", controlType: "AXStaticText",
            value: "Full name", frame: WindowFrame(CGRect(x: 40, y: 80, width: 180, height: 20)), actions: [])
        let field = NativeElement(index: 4, runtimeId: [0, 1], automationId: "", name: "", controlType: "AXTextField",
            value: "", frame: WindowFrame(CGRect(x: 40, y: 108, width: 320, height: 30)), actions: [])
        let result = try await NativeFormMatching.match(title: "Job Application", elements: [label, field],
            entities: [NativeFormEntity(label: "Name", value: "Maya Okafor")])
        let row = try XCTUnwrap((result["recommendations"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["matching_label"] as? String, "Full name")
        XCTAssertEqual(row["label_source"] as? String, "nearby_text_candidate")
        XCTAssertEqual(row["name"] as? String, "")
        XCTAssertEqual(row["element_index"] as? String, "4")
        XCTAssertEqual(row["recommended_value"] as? String, "Maya Okafor")
        XCTAssertEqual(field.name, "", "A geometric label candidate cannot alter the native element binding")
        XCTAssertEqual(field.value, "")
    }

    @MainActor
    func testRealLocalScoringPreservesRecipientsAndExactUserValues() async throws {
        let base = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let cache = base.appendingPathComponent("FluidAudio/Models/cua-s1-forms/cua_s1_forms_fp16_options32.mlmodelc")
        guard FileManager.default.fileExists(atPath: cache.path) else {
            throw XCTSkip("Explicit model preparation is required for real CoreML validation; this test never downloads.")
        }
        let entities = [NativeFormEntity(label: "Company", value: " 海风测试🙂 "),
                        NativeFormEntity(label: "Work email", value: "qa@example.test")]
        let fields = [
            NativeElement(index: 7, runtimeId: [0, 1], automationId: "company", name: "公司", controlType: "AXTextField", value: "旧公司", frame: nil, actions: []),
            NativeElement(index: 11, runtimeId: [0, 2], automationId: "billing", name: "账单邮箱", controlType: "AXTextField", value: "保留@example.test", frame: nil, actions: []),
            NativeElement(index: 15, runtimeId: [0, 3], automationId: "submit", name: "提交", controlType: "AXButton", value: "", frame: nil, actions: ["AXPress"])
        ]
        let result = try await NativeFormMatching.match(title: "海风测试", elements: fields, entities: entities)
        XCTAssertEqual(result["status"] as? String, "scored")
        XCTAssertEqual(result["execution"] as? String, "local-coreml")
        let rows = try XCTUnwrap(result["recommendations"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2, "Submission controls must not become field recommendations")
        for (row, field) in zip(rows, fields) {
            XCTAssertEqual(row["element_index"] as? String, String(field.index))
            XCTAssertEqual(row["current_value"] as? String, field.value)
            XCTAssertNotNil(row["probabilities"])
            XCTAssertNotNil(row["context_truncated"])
            if let index = row["entity_index"] as? Int {
                XCTAssertTrue(entities.indices.contains(index))
                XCTAssertEqual(row["recommended_value"] as? String, entities[index].value)
            } else {
                XCTAssertNil(row["recommended_value"])
            }
        }
        XCTAssertEqual(fields[0].value, "旧公司")
        XCTAssertEqual(fields[1].value, "保留@example.test")
        print("Real local FORMS evidence: \(result)")
    }
}
